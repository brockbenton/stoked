//! Program tests on LiteSVM: the compiled `.so`, the bundled Token-2022
//! program, and a cluster clock the tests set. Build first: `cargo build-sbf`.

use anchor_lang::{
    error::ErrorCode as Anchor, prelude::Pubkey, AccountDeserialize, InstructionData,
    ToAccountMetas,
};
use anchor_spl::token_2022::spl_token_2022::{
    self as token,
    extension::{
        metadata_pointer, scaled_ui_amount, transfer_fee, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    state::{Account as TokenState, Mint as MintState},
};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, TransactionError};
use spl_associated_token_account_interface::{
    address::get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use stoked_escrow::{EscrowError, Gift, GiftStatus};

const NOW: i64 = 1_800_000_000;
const OPEN_AT: i64 = NOW + 100;
const EXPIRES_AT: i64 = NOW + 1_000;
const AMOUNT: u64 = 4_356_918;
const SUPPLY: u64 = 1_000_000_000;
const DECIMALS: u8 = 8;
const TOKEN_2022: Pubkey = token::ID;

/// What to put on a test mint besides the app's three extensions.
#[derive(Clone, Copy, PartialEq)]
enum Odd {
    None,
    FreezeAuthority,
    TransferFee,
    PermanentDelegate,
}

struct Env {
    svm: LiteSVM,
    /// The treasury: gift sender, fee payer and mint authority.
    sender: Keypair,
    mint: Pubkey,
}

#[derive(Clone)]
struct Terms {
    id: [u8; 16],
    mint: Pubkey,
    claim_key: Pubkey,
    amount: u64,
    open_at: i64,
    expires_at: i64,
}

/// A created gift and the key that can claim it.
struct Made {
    gift: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    claim: Keypair,
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022)
}

fn gift_address(sender: &Pubkey, id: &[u8; 16]) -> Pubkey {
    Pubkey::find_program_address(&[b"gift", sender.as_ref(), id], &stoked_escrow::ID).0
}

fn vault_address(gift: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", gift.as_ref()], &stoked_escrow::ID).0
}

fn signed(svm: &LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> VersionedTransaction {
    let message =
        Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &svm.latest_blockhash());
    VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap()
}

/// Each send uses a new blockhash, so a repeat reaches the program instead of
/// being dropped as an already-processed transaction.
fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
    svm.expire_blockhash();
    let tx = signed(svm, ixs, signers);
    svm.send_transaction(tx)
}

#[track_caller]
fn assert_code(result: TransactionResult, code: impl Into<u32>) {
    let code = code.into();
    let failed = result.expect_err("transaction should have failed");
    match failed.err {
        TransactionError::InstructionError(_, InstructionError::Custom(got)) => {
            assert_eq!(got, code, "logs: {:#?}", failed.meta.logs)
        }
        other => panic!("expected custom error {code}, got {other:?}: {:#?}", failed.meta.logs),
    }
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, odd: Odd) -> Pubkey {
    let mint = Keypair::new();
    let m = mint.pubkey();
    let me = payer.pubkey();
    let mut extensions = vec![ExtensionType::MetadataPointer, ExtensionType::ScaledUiAmount];
    match odd {
        Odd::TransferFee => extensions.push(ExtensionType::TransferFeeConfig),
        Odd::PermanentDelegate => extensions.push(ExtensionType::PermanentDelegate),
        _ => {}
    }
    let space = ExtensionType::try_calculate_account_len::<MintState>(&extensions).unwrap();
    // Rent for the final size: the metadata instruction grows the account.
    let lamports = svm.minimum_balance_for_rent_exemption(space + 512);
    let mut ixs = vec![
        solana_system_interface::instruction::create_account(
            &me,
            &m,
            lamports,
            space as u64,
            &TOKEN_2022,
        ),
        metadata_pointer::instruction::initialize(&TOKEN_2022, &m, Some(me), Some(m)).unwrap(),
        scaled_ui_amount::instruction::initialize(&TOKEN_2022, &m, Some(me), 1.0).unwrap(),
    ];
    if odd == Odd::TransferFee {
        ixs.push(
            transfer_fee::instruction::initialize_transfer_fee_config(
                &TOKEN_2022,
                &m,
                Some(&me),
                Some(&me),
                100,
                1_000,
            )
            .unwrap(),
        );
    }
    if odd == Odd::PermanentDelegate {
        ixs.push(token::instruction::initialize_permanent_delegate(&TOKEN_2022, &m, &me).unwrap());
    }
    let freeze = (odd == Odd::FreezeAuthority).then_some(&me);
    ixs.push(
        token::instruction::initialize_mint2(&TOKEN_2022, &m, &me, freeze, DECIMALS).unwrap(),
    );
    ixs.push(spl_token_metadata_interface::instruction::initialize(
        &TOKEN_2022,
        &m,
        &me,
        &m,
        &me,
        "Nvidia (devnet test token)".into(),
        "tNVDA".into(),
        String::new(),
    ));
    ixs.push(create_associated_token_account_idempotent(&me, &me, &m, &TOKEN_2022));
    ixs.push(
        token::instruction::mint_to_checked(
            &TOKEN_2022,
            &m,
            &ata(&me, &m),
            &me,
            &[],
            SUPPLY,
            DECIMALS,
        )
        .unwrap(),
    );
    send(svm, &ixs, &[payer, &mint]).expect("create mint");
    m
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy/stoked_escrow.so");
        svm.add_program_from_file(stoked_escrow::ID, path)
            .expect("run `cargo build-sbf` before the tests");
        let sender = Keypair::new();
        svm.airdrop(&sender.pubkey(), 100_000_000_000).unwrap();
        let mint = create_mint(&mut svm, &sender, Odd::None);
        let mut env = Env { svm, sender, mint };
        env.warp(NOW);
        env
    }

    fn warp(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    fn terms(&self, n: u8, claim_key: Pubkey) -> Terms {
        Terms {
            id: [n; 16],
            mint: self.mint,
            claim_key,
            amount: AMOUNT,
            open_at: OPEN_AT,
            expires_at: EXPIRES_AT,
        }
    }

    fn create_ix(&self, t: &Terms) -> Instruction {
        let sender = self.sender.pubkey();
        let gift = gift_address(&sender, &t.id);
        Instruction {
            program_id: stoked_escrow::ID,
            accounts: stoked_escrow::accounts::CreateGift {
                sender,
                mint: t.mint,
                sender_token: ata(&sender, &t.mint),
                gift,
                vault: vault_address(&gift),
                token_program: TOKEN_2022,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: stoked_escrow::instruction::CreateGift {
                gift_id: t.id,
                claim_key: t.claim_key,
                amount: t.amount,
                open_at: t.open_at,
                expires_at: t.expires_at,
            }
            .data(),
        }
    }

    fn try_create(&mut self, t: &Terms) -> TransactionResult {
        let ix = self.create_ix(t);
        send(&mut self.svm, &[ix], &[&self.sender])
    }

    fn create(&mut self, n: u8) -> Made {
        let claim = Keypair::new();
        let t = self.terms(n, claim.pubkey());
        self.try_create(&t).expect("create");
        let gift = gift_address(&self.sender.pubkey(), &t.id);
        Made {
            gift,
            vault: vault_address(&gift),
            mint: t.mint,
            claim,
        }
    }

    fn claim_accounts(&self, g: &Made, recipient: Pubkey) -> stoked_escrow::accounts::Claim {
        stoked_escrow::accounts::Claim {
            claim_key: g.claim.pubkey(),
            recipient,
            sender: self.sender.pubkey(),
            gift: g.gift,
            mint: g.mint,
            vault: g.vault,
            recipient_token: ata(&recipient, &g.mint),
            token_program: TOKEN_2022,
        }
    }

    fn ata_ix(&self, owner: &Pubkey, mint: &Pubkey) -> Instruction {
        create_associated_token_account_idempotent(&self.sender.pubkey(), owner, mint, &TOKEN_2022)
    }

    /// ATA creation (as the client does) followed by the given claim accounts.
    fn send_claim(
        &mut self,
        accounts: stoked_escrow::accounts::Claim,
        claim_key: &Keypair,
    ) -> TransactionResult {
        let ata_ix = self.ata_ix(&accounts.recipient, &self.mint);
        let ix = claim_ix(accounts);
        send(&mut self.svm, &[ata_ix, ix], &[&self.sender, claim_key])
    }

    fn claim(&mut self, g: &Made, recipient: Pubkey) -> TransactionResult {
        let accounts = self.claim_accounts(g, recipient);
        self.send_claim(accounts, &g.claim)
    }

    fn refund_accounts(&self, g: &Made) -> stoked_escrow::accounts::Refund {
        let sender = self.sender.pubkey();
        stoked_escrow::accounts::Refund {
            sender,
            gift: g.gift,
            mint: g.mint,
            vault: g.vault,
            sender_token: ata(&sender, &g.mint),
            token_program: TOKEN_2022,
        }
    }

    fn refund(&mut self, g: &Made) -> TransactionResult {
        let ix = refund_ix(self.refund_accounts(g));
        send(&mut self.svm, &[ix], &[&self.sender])
    }

    /// Raw balance, or None if the account doesn't exist.
    fn raw(&self, account: &Pubkey) -> Option<u64> {
        let a = self.svm.get_account(account).filter(|a| !a.data.is_empty())?;
        Some(StateWithExtensions::<TokenState>::unpack(&a.data).unwrap().base.amount)
    }

    fn sender_raw(&self) -> u64 {
        self.raw(&ata(&self.sender.pubkey(), &self.mint)).unwrap()
    }

    fn gift(&self, address: &Pubkey) -> Gift {
        let a = self.svm.get_account(address).expect("gift account");
        Gift::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn assert_untouched(&self, g: &Made) {
        assert_eq!(self.raw(&g.vault), Some(AMOUNT));
        assert_eq!(self.gift(&g.gift).status, GiftStatus::Open);
    }
}

fn claim_ix(accounts: stoked_escrow::accounts::Claim) -> Instruction {
    Instruction {
        program_id: stoked_escrow::ID,
        accounts: accounts.to_account_metas(None),
        data: stoked_escrow::instruction::Claim {}.data(),
    }
}

fn refund_ix(accounts: stoked_escrow::accounts::Refund) -> Instruction {
    Instruction {
        program_id: stoked_escrow::ID,
        accounts: accounts.to_account_metas(None),
        data: stoked_escrow::instruction::Refund {}.data(),
    }
}

/// Swap one account key in an already signed transaction, keeping signatures.
fn tamper(tx: &mut VersionedTransaction, from: &Pubkey, to: &Pubkey) {
    let VersionedMessage::Legacy(message) = &mut tx.message else {
        panic!("legacy message expected")
    };
    let key = message
        .account_keys
        .iter_mut()
        .find(|k| **k == *from)
        .expect("key in message");
    *key = *to;
}

fn new_wallet() -> Pubkey {
    Keypair::new().pubkey()
}

// ---------- create and claim ----------

#[test]
fn create_locks_the_amount_in_the_vault() {
    let mut env = Env::new();
    let g = env.create(1);
    assert_eq!(env.raw(&g.vault), Some(AMOUNT));
    assert_eq!(env.sender_raw(), SUPPLY - AMOUNT);
    let gift = env.gift(&g.gift);
    assert_eq!(gift.sender, env.sender.pubkey());
    assert_eq!(gift.claim_key, g.claim.pubkey());
    assert_eq!(gift.mint, env.mint);
    assert_eq!(gift.amount, AMOUNT);
    assert_eq!((gift.open_at, gift.expires_at), (OPEN_AT, EXPIRES_AT));
    assert_eq!(gift.status, GiftStatus::Open);
    assert_eq!(gift.recipient, Pubkey::default());
    // The sizes documented in docs/escrow.md.
    assert_eq!(env.svm.get_account(&g.gift).unwrap().data.len(), 179);
    assert_eq!(env.svm.get_account(&g.vault).unwrap().data.len(), 165);
}

#[test]
fn create_then_claim_releases_the_exact_amount_and_closes_the_vault() {
    let mut env = Env::new();
    let g = env.create(1);
    let recipient = new_wallet();
    env.warp(OPEN_AT + 1);
    env.claim(&g, recipient).expect("claim");
    assert_eq!(env.raw(&ata(&recipient, &env.mint)), Some(AMOUNT));
    assert_eq!(env.raw(&g.vault), None, "vault closed");
    let gift = env.gift(&g.gift);
    assert_eq!(gift.status, GiftStatus::Claimed);
    assert_eq!(gift.recipient, recipient);
}

#[test]
fn claim_returns_the_vault_rent_to_the_sender() {
    let mut env = Env::new();
    let g = env.create(1);
    let recipient = new_wallet();
    let rent = env.svm.get_account(&g.vault).unwrap().lamports;
    // A separate fee payer, so the sender's balance only moves by the rent.
    let relayer = Keypair::new();
    env.svm.airdrop(&relayer.pubkey(), 1_000_000_000).unwrap();
    let before = env.svm.get_account(&env.sender.pubkey()).unwrap().lamports;
    env.warp(OPEN_AT);
    let ata_ix = create_associated_token_account_idempotent(
        &relayer.pubkey(),
        &recipient,
        &env.mint,
        &TOKEN_2022,
    );
    let ix = claim_ix(env.claim_accounts(&g, recipient));
    send(&mut env.svm, &[ata_ix, ix], &[&relayer, &g.claim]).expect("any fee payer can relay");
    let after = env.svm.get_account(&env.sender.pubkey()).unwrap().lamports;
    assert_eq!(after - before, rent);
}

#[test]
fn early_claim_fails_and_succeeds_at_the_open_time() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(OPEN_AT - 1);
    assert_code(env.claim(&g, new_wallet()), EscrowError::TooEarly);
    env.assert_untouched(&g);
    env.warp(OPEN_AT);
    env.claim(&g, new_wallet()).expect("claim at open_at");
}

#[test]
fn double_claim_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    let first = new_wallet();
    env.warp(OPEN_AT);
    env.claim(&g, first).expect("first claim");
    // The vault is gone, so a second claim can't even load it.
    assert_code(env.claim(&g, new_wallet()), Anchor::AccountNotInitialized);
    assert_code(env.claim(&g, first), Anchor::AccountNotInitialized);
    assert_eq!(env.raw(&ata(&first, &env.mint)), Some(AMOUNT));
    assert_eq!(env.gift(&g.gift).recipient, first);
}

#[test]
fn status_alone_refuses_a_second_claim_or_refund_even_with_a_funded_vault() {
    let mut env = Env::new();
    let g = env.create(1);
    let funded_vault = env.svm.get_account(&g.vault).unwrap();
    env.warp(OPEN_AT);
    env.claim(&g, new_wallet()).expect("claim");
    // Impossible on a real cluster; isolates the status check.
    env.svm.set_account(g.vault, funded_vault).unwrap();
    assert_code(env.claim(&g, new_wallet()), EscrowError::NotOpen);
    env.warp(EXPIRES_AT);
    assert_code(env.refund(&g), EscrowError::NotOpen);
    assert_eq!(env.raw(&g.vault), Some(AMOUNT));
}

// ---------- authorization and substitution ----------

#[test]
fn wrong_claim_key_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(OPEN_AT);
    let wrong = Keypair::new();
    let mut accounts = env.claim_accounts(&g, new_wallet());
    accounts.claim_key = wrong.pubkey();
    assert_code(env.send_claim(accounts, &wrong), EscrowError::WrongClaimKey);
    env.assert_untouched(&g);
}

#[test]
fn claim_without_the_claim_key_signature_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(OPEN_AT);
    let recipient = new_wallet();
    let ata_ix = env.ata_ix(&recipient, &env.mint);
    let mut ix = claim_ix(env.claim_accounts(&g, recipient));
    ix.accounts[0].is_signer = false;
    assert_code(
        send(&mut env.svm, &[ata_ix, ix], &[&env.sender]),
        Anchor::AccountNotSigner,
    );
    env.assert_untouched(&g);
}

#[test]
fn substituted_recipient_in_a_signed_claim_fails_signature_verification() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(OPEN_AT);
    let (intended, attacker) = (new_wallet(), new_wallet());
    let attacker_ata_ix = env.ata_ix(&attacker, &env.mint);
    send(&mut env.svm, &[attacker_ata_ix], &[&env.sender]).unwrap();
    let ata_ix = env.ata_ix(&intended, &env.mint);
    let ix = claim_ix(env.claim_accounts(&g, intended));
    let original = signed(&env.svm, &[ata_ix, ix], &[&env.sender, &g.claim]);

    let mut stolen = original.clone();
    tamper(&mut stolen, &intended, &attacker);
    tamper(&mut stolen, &ata(&intended, &env.mint), &ata(&attacker, &env.mint));
    // Even with the attacker re-signing as fee payer, the claim key's
    // signature covers the old accounts.
    stolen.signatures[0] = env.sender.sign_message(&stolen.message.serialize());
    let failed = env.svm.send_transaction(stolen).expect_err("tampered");
    assert_eq!(failed.err, TransactionError::SignatureFailure);
    env.assert_untouched(&g);

    env.svm.send_transaction(original).expect("the untouched transaction still works");
    assert_eq!(env.raw(&ata(&intended, &env.mint)), Some(AMOUNT));
}

#[test]
fn substituted_recipient_token_account_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(OPEN_AT);
    let (intended, attacker) = (new_wallet(), new_wallet());
    let attacker_ata_ix = env.ata_ix(&attacker, &env.mint);
    send(&mut env.svm, &[attacker_ata_ix], &[&env.sender]).unwrap();
    // Signed for `intended`, but pointing the tokens at the attacker's account.
    let mut accounts = env.claim_accounts(&g, intended);
    accounts.recipient_token = ata(&attacker, &env.mint);
    assert_code(env.send_claim(accounts, &g.claim), Anchor::ConstraintTokenOwner);
    env.assert_untouched(&g);
}

#[test]
fn recipient_token_must_be_the_associated_account() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(OPEN_AT);
    let recipient = new_wallet();
    let other = Keypair::new();
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    let ixs = [
        solana_system_interface::instruction::create_account(
            &env.sender.pubkey(),
            &other.pubkey(),
            rent,
            165,
            &TOKEN_2022,
        ),
        token::instruction::initialize_account3(&TOKEN_2022, &other.pubkey(), &env.mint, &recipient)
            .unwrap(),
    ];
    send(&mut env.svm, &ixs, &[&env.sender, &other]).unwrap();
    let mut accounts = env.claim_accounts(&g, recipient);
    accounts.recipient_token = other.pubkey();
    assert_code(env.send_claim(accounts, &g.claim), Anchor::ConstraintAssociated);
    env.assert_untouched(&g);
}

#[test]
fn substituted_mint_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    let other_mint = create_mint(&mut env.svm, &env.sender, Odd::None);
    env.warp(OPEN_AT);
    let recipient = new_wallet();
    let ata_ix = env.ata_ix(&recipient, &other_mint);
    let mut accounts = env.claim_accounts(&g, recipient);
    accounts.mint = other_mint;
    accounts.recipient_token = ata(&recipient, &other_mint);
    let ix = claim_ix(accounts);
    assert_code(
        send(&mut env.svm, &[ata_ix, ix], &[&env.sender, &g.claim]),
        EscrowError::WrongMint,
    );
    env.warp(EXPIRES_AT);
    let mut accounts = env.refund_accounts(&g);
    accounts.mint = other_mint;
    accounts.sender_token = ata(&env.sender.pubkey(), &other_mint);
    let ix = refund_ix(accounts);
    assert_code(
        send(&mut env.svm, &[ix], &[&env.sender]),
        EscrowError::WrongMint,
    );
    env.assert_untouched(&g);
}

#[test]
fn substituted_vault_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    let other = env.create(2);
    env.warp(OPEN_AT);
    // Another gift's vault.
    let mut accounts = env.claim_accounts(&g, new_wallet());
    accounts.vault = other.vault;
    assert_code(env.send_claim(accounts, &g.claim), Anchor::ConstraintSeeds);
    // An ordinary token account of the same mint.
    let mut accounts = env.claim_accounts(&g, new_wallet());
    accounts.vault = ata(&env.sender.pubkey(), &env.mint);
    assert_code(env.send_claim(accounts, &g.claim), Anchor::ConstraintSeeds);
    env.warp(EXPIRES_AT);
    let mut accounts = env.refund_accounts(&g);
    accounts.vault = other.vault;
    let ix = refund_ix(accounts);
    assert_code(send(&mut env.svm, &[ix], &[&env.sender]), Anchor::ConstraintSeeds);
    env.assert_untouched(&g);
    env.assert_untouched(&other);
}

#[test]
fn substituted_token_program_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    let classic = anchor_spl::token::ID;

    let mut ix = env.create_ix(&env.terms(2, new_wallet()));
    ix.accounts[5].pubkey = classic;
    assert_code(send(&mut env.svm, &[ix], &[&env.sender]), Anchor::InvalidProgramId);

    env.warp(OPEN_AT);
    let mut accounts = env.claim_accounts(&g, new_wallet());
    accounts.token_program = classic;
    assert_code(env.send_claim(accounts, &g.claim), Anchor::InvalidProgramId);

    env.warp(EXPIRES_AT);
    let mut accounts = env.refund_accounts(&g);
    accounts.token_program = classic;
    let ix = refund_ix(accounts);
    assert_code(send(&mut env.svm, &[ix], &[&env.sender]), Anchor::InvalidProgramId);
    env.assert_untouched(&g);
}

#[test]
fn substituted_sender_cannot_take_the_vault_rent() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(OPEN_AT);
    let mut accounts = env.claim_accounts(&g, new_wallet());
    accounts.sender = new_wallet();
    assert_code(env.send_claim(accounts, &g.claim), EscrowError::WrongSender);
    env.assert_untouched(&g);
}

#[test]
fn claim_key_signature_does_not_replay_across_gifts() {
    let mut env = Env::new();
    let a = env.create(1);
    // Gift b deliberately shares a's claim key: only the signature separates them.
    let t = env.terms(2, a.claim.pubkey());
    env.try_create(&t).unwrap();
    let b_gift = gift_address(&env.sender.pubkey(), &t.id);
    let b_vault = vault_address(&b_gift);
    env.warp(OPEN_AT);
    let recipient = new_wallet();
    let ata_ix = env.ata_ix(&recipient, &env.mint);
    let ix = claim_ix(env.claim_accounts(&a, recipient));
    let mut replay = signed(&env.svm, &[ata_ix, ix], &[&env.sender, &a.claim]);
    tamper(&mut replay, &a.gift, &b_gift);
    tamper(&mut replay, &a.vault, &b_vault);
    replay.signatures[0] = env.sender.sign_message(&replay.message.serialize());
    let failed = env.svm.send_transaction(replay).expect_err("replayed");
    assert_eq!(failed.err, TransactionError::SignatureFailure);
    assert_eq!(env.raw(&b_vault), Some(AMOUNT));
}

#[test]
fn another_gifts_claim_key_cannot_claim() {
    let mut env = Env::new();
    let a = env.create(1);
    let b = env.create(2);
    env.warp(OPEN_AT);
    let mut accounts = env.claim_accounts(&b, new_wallet());
    accounts.claim_key = a.claim.pubkey();
    assert_code(env.send_claim(accounts, &a.claim), EscrowError::WrongClaimKey);
    env.assert_untouched(&b);
}

// ---------- refund and ordering ----------

#[test]
fn refund_before_expiry_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    for t in [NOW, OPEN_AT, EXPIRES_AT - 1] {
        env.warp(t);
        assert_code(env.refund(&g), EscrowError::NotExpired);
    }
    env.assert_untouched(&g);
}

#[test]
fn refund_after_expiry_returns_the_tokens_to_the_sender() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(EXPIRES_AT);
    env.refund(&g).expect("refund at expires_at");
    assert_eq!(env.sender_raw(), SUPPLY);
    assert_eq!(env.raw(&g.vault), None);
    assert_eq!(env.gift(&g.gift).status, GiftStatus::Refunded);
    assert_code(env.refund(&g), Anchor::AccountNotInitialized);
}

#[test]
fn only_the_sender_can_refund_and_only_to_itself() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(EXPIRES_AT);
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let ata_ix = env.ata_ix(&attacker.pubkey(), &env.mint);
    send(&mut env.svm, &[ata_ix], &[&env.sender]).unwrap();

    let mut accounts = env.refund_accounts(&g);
    accounts.sender = attacker.pubkey();
    accounts.sender_token = ata(&attacker.pubkey(), &env.mint);
    let ix = refund_ix(accounts);
    assert_code(send(&mut env.svm, &[ix], &[&attacker]), EscrowError::WrongSender);

    let mut accounts = env.refund_accounts(&g);
    accounts.sender_token = ata(&attacker.pubkey(), &env.mint);
    let ix = refund_ix(accounts);
    assert_code(
        send(&mut env.svm, &[ix], &[&env.sender]),
        Anchor::ConstraintTokenOwner,
    );
    env.assert_untouched(&g);
}

#[test]
fn claim_wins_before_expiry_and_refund_then_fails() {
    let mut env = Env::new();
    let g = env.create(1);
    let recipient = new_wallet();
    env.warp(EXPIRES_AT - 1);
    assert_code(env.refund(&g), EscrowError::NotExpired);
    env.claim(&g, recipient).expect("claim in the last second");
    env.warp(EXPIRES_AT);
    assert_code(env.refund(&g), Anchor::AccountNotInitialized);
    assert_eq!(env.raw(&ata(&recipient, &env.mint)), Some(AMOUNT));
    assert_eq!(env.sender_raw(), SUPPLY - AMOUNT);
    assert_eq!(env.gift(&g.gift).status, GiftStatus::Claimed);
}

#[test]
fn claim_after_expiry_fails_and_refund_then_blocks_claim() {
    let mut env = Env::new();
    let g = env.create(1);
    env.warp(EXPIRES_AT);
    // Expired but not yet refunded: still no claim.
    assert_code(env.claim(&g, new_wallet()), EscrowError::Expired);
    env.assert_untouched(&g);
    env.refund(&g).expect("refund");
    assert_code(env.claim(&g, new_wallet()), Anchor::AccountNotInitialized);
    assert_eq!(env.sender_raw(), SUPPLY);
}

#[test]
fn extra_tokens_sent_to_a_vault_block_neither_claim_nor_refund() {
    let mut env = Env::new();
    let claimed = env.create(1);
    let refunded = env.create(2);
    let from = ata(&env.sender.pubkey(), &env.mint);
    for vault in [claimed.vault, refunded.vault] {
        let ix = token::instruction::transfer_checked(
            &TOKEN_2022,
            &from,
            &env.mint,
            &vault,
            &env.sender.pubkey(),
            &[],
            1,
            DECIMALS,
        )
        .unwrap();
        send(&mut env.svm, &[ix], &[&env.sender]).unwrap();
    }
    let recipient = new_wallet();
    env.warp(OPEN_AT);
    env.claim(&claimed, recipient).expect("claim");
    assert_eq!(env.raw(&ata(&recipient, &env.mint)), Some(AMOUNT + 1));
    env.warp(EXPIRES_AT);
    env.refund(&refunded).expect("refund");
    assert_eq!(env.sender_raw(), SUPPLY - AMOUNT - 1);
}

// ---------- Token-2022 ----------

#[test]
fn multiplier_change_leaves_the_raw_amount_unchanged() {
    let mut env = Env::new();
    let claimed = env.create(1);
    let refunded = env.create(2);
    let ix = scaled_ui_amount::instruction::update_multiplier(
        &TOKEN_2022,
        &env.mint,
        &env.sender.pubkey(),
        &[],
        1.002,
        NOW,
    )
    .unwrap();
    send(&mut env.svm, &[ix], &[&env.sender]).expect("update multiplier");
    let data = env.svm.get_account(&env.mint).unwrap().data;
    let mint = StateWithExtensions::<MintState>::unpack(&data).unwrap();
    let config = mint
        .get_extension::<scaled_ui_amount::ScaledUiAmountConfig>()
        .unwrap();
    assert_eq!(f64::from(config.new_multiplier), 1.002);

    assert_eq!(env.raw(&claimed.vault), Some(AMOUNT));
    assert_eq!(env.gift(&claimed.gift).amount, AMOUNT);
    let recipient = new_wallet();
    env.warp(OPEN_AT);
    env.claim(&claimed, recipient).expect("claim");
    assert_eq!(env.raw(&ata(&recipient, &env.mint)), Some(AMOUNT));
    env.warp(EXPIRES_AT);
    env.refund(&refunded).expect("refund");
    assert_eq!(env.sender_raw(), SUPPLY - AMOUNT);
}

#[test]
fn unsupported_mints_are_refused() {
    let mut env = Env::new();
    for odd in [Odd::FreezeAuthority, Odd::TransferFee, Odd::PermanentDelegate] {
        let mint = create_mint(&mut env.svm, &env.sender, odd);
        let mut t = env.terms(1, new_wallet());
        t.mint = mint;
        assert_code(env.try_create(&t), EscrowError::UnsupportedMint);
        assert_eq!(env.raw(&ata(&env.sender.pubkey(), &mint)), Some(SUPPLY));
    }
}

// ---------- create validation ----------

#[test]
fn create_refuses_bad_terms() {
    let mut env = Env::new();
    let good = env.terms(1, new_wallet());
    let mut zero = good.clone();
    zero.amount = 0;
    assert_code(env.try_create(&zero), EscrowError::ZeroAmount);
    for (open_at, expires_at) in [(OPEN_AT, OPEN_AT), (OPEN_AT, OPEN_AT - 1), (0, NOW)] {
        let mut t = good.clone();
        (t.open_at, t.expires_at) = (open_at, expires_at);
        assert_code(env.try_create(&t), EscrowError::InvalidWindow);
    }
    let mut too_much = good.clone();
    too_much.amount = SUPPLY + 1;
    // Token program error 1: insufficient funds.
    assert_code(env.try_create(&too_much), 1u32);
    assert_eq!(env.sender_raw(), SUPPLY);
    env.try_create(&good).expect("good terms");
}

#[test]
fn create_cannot_reuse_a_gift_address_even_after_claim() {
    let mut env = Env::new();
    let g = env.create(1);
    let again = env.terms(1, new_wallet());
    // System program error 0: account already in use.
    assert_code(env.try_create(&again), 0u32);
    env.warp(OPEN_AT);
    env.claim(&g, new_wallet()).unwrap();
    assert_code(env.try_create(&again), 0u32);
}

#[test]
fn create_cannot_spend_someone_elses_tokens() {
    let mut env = Env::new();
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let t = env.terms(1, new_wallet());
    let gift = gift_address(&attacker.pubkey(), &t.id);
    let mut ix = env.create_ix(&t);
    ix.accounts[0].pubkey = attacker.pubkey();
    ix.accounts[3].pubkey = gift;
    ix.accounts[4].pubkey = vault_address(&gift);
    assert_code(
        send(&mut env.svm, &[ix], &[&attacker]),
        Anchor::ConstraintTokenOwner,
    );
    assert_eq!(env.sender_raw(), SUPPLY);
}

#[test]
fn lamports_sent_to_the_addresses_first_do_not_block_create() {
    let mut env = Env::new();
    let t = env.terms(1, new_wallet());
    let gift = gift_address(&env.sender.pubkey(), &t.id);
    for address in [gift, vault_address(&gift)] {
        env.svm.airdrop(&address, 1_000_000).unwrap();
    }
    env.try_create(&t).expect("create");
    assert_eq!(env.raw(&vault_address(&gift)), Some(AMOUNT));
}
