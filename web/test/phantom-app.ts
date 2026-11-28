/**
 * The Phantom app's side of its deeplinks, for tests: takes the link a page
 * built and returns the address it would send the person back to.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export function fakePhantomApp(sign: (transaction: string) => string = (t) => t, address?: string) {
  const wallet = address ?? Keypair.generate().publicKey.toBase58();
  const box = nacl.box.keyPair();
  const session = bs58.encode(nacl.randomBytes(32));
  const secrets = new Map<string, Uint8Array>();

  const seal = (secret: Uint8Array, value: unknown) => {
    const nonce = nacl.randomBytes(24);
    const data = nacl.box.after(new TextEncoder().encode(JSON.stringify(value)), nonce, secret);
    return { nonce: bs58.encode(nonce), data: bs58.encode(data) };
  };

  return {
    address: wallet,
    session,
    handle(link: string): URL {
      const url = new URL(link);
      const q = url.searchParams;
      const dapp = q.get("dapp_encryption_public_key")!;
      const back = new URL(q.get("redirect_link")!);
      const reply = (fields: Record<string, string>) => {
        for (const [k, v] of Object.entries(fields)) back.searchParams.append(k, v);
        return back;
      };
      if (url.pathname.endsWith("/connect")) {
        const secret = nacl.box.before(bs58.decode(dapp), box.secretKey);
        secrets.set(dapp, secret);
        return reply({
          phantom_encryption_public_key: bs58.encode(box.publicKey),
          ...seal(secret, { public_key: wallet, session }),
        });
      }
      const secret = secrets.get(dapp);
      const opened =
        secret && nacl.box.open.after(bs58.decode(q.get("payload")!), bs58.decode(q.get("nonce")!), secret);
      if (!opened) return reply({ errorCode: "4100", errorMessage: "unauthorized" });
      const payload = JSON.parse(new TextDecoder().decode(opened)) as { transaction: string; session: string };
      if (payload.session !== session) return reply({ errorCode: "4100", errorMessage: "unauthorized" });
      return reply(seal(secret!, { transaction: sign(payload.transaction) }));
    },
  };
}
