//! Stoked gift escrow: one vault per gift, for Token-2022 mints.
//!
//! `create_gift` locks tokens, `claim` releases them to a wallet chosen by the
//! gift's claim key (from `open_at` until `expires_at`), and `refund` returns
//! them to the sender from `expires_at`. Accounts, rules and threat model:
//! docs/escrow.md. All amounts are raw token units.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{
        spl_token_2022::{
            extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
            state::Mint as MintState,
        },
        Token2022,
    },
    token_interface::{
        close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TransferChecked,
    },
};

declare_id!("eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB");

pub const GIFT_SEED: &[u8] = b"gift";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod stoked_escrow {
    use super::*;

    /// Lock `amount` raw units of the sender's tokens in a new gift's vault.
    pub fn create_gift(
        ctx: Context<CreateGift>,
        gift_id: [u8; 16],
        claim_key: Pubkey,
        amount: u64,
        open_at: i64,
        expires_at: i64,
    ) -> Result<()> {
        require_supported_mint(&ctx.accounts.mint.to_account_info())?;
        require!(amount > 0, EscrowError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(
            expires_at > open_at && expires_at > now,
            EscrowError::InvalidWindow
        );

        ctx.accounts.gift.set_inner(Gift {
            sender: ctx.accounts.sender.key(),
            gift_id,
            claim_key,
            mint: ctx.accounts.mint.key(),
            amount,
            open_at,
            expires_at,
            status: GiftStatus::Open,
            recipient: Pubkey::default(),
            bump: ctx.bumps.gift,
            vault_bump: ctx.bumps.vault,
        });

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.sender_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// Release the vault to `recipient`, once, inside the claim window.
    ///
    /// The claim key signs the transaction, and that signature covers the
    /// program, every account (gift and recipient included) and the data.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let gift = &mut ctx.accounts.gift;
        require!(gift.status == GiftStatus::Open, EscrowError::NotOpen);
        require!(now >= gift.open_at, EscrowError::TooEarly);
        require!(now < gift.expires_at, EscrowError::Expired);

        // State changes before tokens move.
        gift.status = GiftStatus::Claimed;
        gift.recipient = ctx.accounts.recipient.key();

        empty_vault(
            &ctx.accounts.gift,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            ctx.accounts.recipient_token.to_account_info(),
            ctx.accounts.sender.to_account_info(),
            ctx.accounts.token_program.key(),
        )
    }

    /// Return the vault to the sender, once the gift has expired unclaimed.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let gift = &mut ctx.accounts.gift;
        require!(gift.status == GiftStatus::Open, EscrowError::NotOpen);
        require!(now >= gift.expires_at, EscrowError::NotExpired);

        gift.status = GiftStatus::Refunded;

        empty_vault(
            &ctx.accounts.gift,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            ctx.accounts.sender_token.to_account_info(),
            ctx.accounts.sender.to_account_info(),
            ctx.accounts.token_program.key(),
        )
    }
}

/// Only extensions that can't move, tax, freeze or block the vault, and no
/// freeze authority.
fn require_supported_mint(mint: &AccountInfo) -> Result<()> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)?;
    require!(
        state.base.freeze_authority.is_none(),
        EscrowError::UnsupportedMint
    );
    for extension in state.get_extension_types()? {
        require!(
            matches!(
                extension,
                ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
                    | ExtensionType::ScaledUiAmount
            ),
            EscrowError::UnsupportedMint
        );
    }
    Ok(())
}

/// Move the vault's whole balance to `destination`, then close the vault and
/// return its rent to the sender. The whole balance, not `gift.amount`: anyone
/// can send a vault extra units, and an account with a balance can't be closed.
fn empty_vault<'info>(
    gift: &Account<'info, Gift>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    destination: AccountInfo<'info>,
    sender: AccountInfo<'info>,
    token_program: Pubkey,
) -> Result<()> {
    let seeds: &[&[u8]] = &[
        GIFT_SEED,
        gift.sender.as_ref(),
        gift.gift_id.as_ref(),
        &[gift.bump],
    ];
    let signer = &[seeds];

    transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination,
                authority: gift.to_account_info(),
            },
            signer,
        ),
        vault.amount,
        mint.decimals,
    )?;
    close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: vault.to_account_info(),
            destination: sender,
            authority: gift.to_account_info(),
        },
        signer,
    ))
}

// ---------- accounts ----------

#[derive(Accounts)]
#[instruction(gift_id: [u8; 16])]
pub struct CreateGift<'info> {
    /// Funds the gift, pays rent, and is the only key that can refund it.
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = sender,
        token::token_program = token_program,
    )]
    pub sender_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = sender,
        space = 8 + Gift::INIT_SPACE,
        seeds = [GIFT_SEED, sender.key().as_ref(), gift_id.as_ref()],
        bump,
    )]
    pub gift: Box<Account<'info, Gift>>,
    #[account(
        init,
        payer = sender,
        seeds = [VAULT_SEED, gift.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = gift,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// Authorizes this claim. Holds no funds; anyone may pay the fee.
    pub claim_key: Signer<'info>,
    /// CHECK: any wallet. The claim key's signature chooses it, and tokens can
    /// only go to its associated token account.
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: receives the vault's rent; must equal `gift.sender`.
    #[account(mut)]
    pub sender: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [GIFT_SEED, gift.sender.as_ref(), gift.gift_id.as_ref()],
        bump = gift.bump,
        has_one = claim_key @ EscrowError::WrongClaimKey,
        has_one = sender @ EscrowError::WrongSender,
        has_one = mint @ EscrowError::WrongMint,
    )]
    pub gift: Box<Account<'info, Gift>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, gift.key().as_ref()],
        bump = gift.vault_bump,
        token::mint = mint,
        token::authority = gift,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(
        mut,
        seeds = [GIFT_SEED, gift.sender.as_ref(), gift.gift_id.as_ref()],
        bump = gift.bump,
        has_one = sender @ EscrowError::WrongSender,
        has_one = mint @ EscrowError::WrongMint,
    )]
    pub gift: Box<Account<'info, Gift>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, gift.key().as_ref()],
        bump = gift.vault_bump,
        token::mint = mint,
        token::authority = gift,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender,
        associated_token::token_program = token_program,
    )]
    pub sender_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
}

// ---------- state ----------

#[account]
#[derive(InitSpace)]
pub struct Gift {
    pub sender: Pubkey,
    /// Random nonce from the sender, so one sender can hold many gifts.
    pub gift_id: [u8; 16],
    /// Public half of the per-gift key that authorizes the claim.
    pub claim_key: Pubkey,
    pub mint: Pubkey,
    /// Raw units locked at creation.
    pub amount: u64,
    /// Cluster time (unix seconds) from which a claim is allowed.
    pub open_at: i64,
    /// Claims are allowed before this time, refunds from it.
    pub expires_at: i64,
    pub status: GiftStatus,
    /// Zero until claimed.
    pub recipient: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum GiftStatus {
    Open,
    Claimed,
    Refunded,
}

#[error_code]
pub enum EscrowError {
    #[msg("The gift amount must be positive")]
    ZeroAmount,
    #[msg("The gift must expire after it opens, and in the future")]
    InvalidWindow,
    #[msg("This mint has a freeze authority or an extension the escrow doesn't accept")]
    UnsupportedMint,
    #[msg("Not this gift's claim key")]
    WrongClaimKey,
    #[msg("Not this gift's sender")]
    WrongSender,
    #[msg("Not this gift's mint")]
    WrongMint,
    #[msg("The gift was already claimed or refunded")]
    NotOpen,
    #[msg("The gift hasn't opened yet")]
    TooEarly,
    #[msg("The gift has expired")]
    Expired,
    #[msg("The gift hasn't expired yet")]
    NotExpired,
}
