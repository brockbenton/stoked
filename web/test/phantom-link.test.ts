/** Phantom's deeplink protocol, with the app's side played by the same encryption. */
import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { PhantomLinkError, connectUrl, newLinkKeys, readConnect, readSigned, signUrl } from "../lib/client/phantom-link";
import { fakePhantomApp } from "./phantom-app";

const keys = newLinkKeys();
const redirect = "https://stoked.example/g/abc?phantom=connect";

describe("connect", () => {
  it("asks for devnet and sends only the public half of a fresh key", () => {
    const url = new URL(connectUrl({ appUrl: "https://stoked.example", redirect, keys }));
    expect(url.origin + url.pathname).toBe("https://phantom.com/ul/v1/connect");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_url: "https://stoked.example",
      dapp_encryption_public_key: keys.publicKey,
      redirect_link: redirect,
      cluster: "devnet",
    });
    expect(url.toString()).not.toContain(keys.secretKey);
    expect(newLinkKeys().publicKey).not.toBe(keys.publicKey);
  });

  it("reads the wallet and session from the reply", () => {
    const app = fakePhantomApp();
    const reply = app.handle(connectUrl({ appUrl: "https://stoked.example", redirect, keys }));
    expect(readConnect(reply.searchParams, keys)).toMatchObject({ address: app.address, session: app.session });
    expect(reply.searchParams.get("phantom")).toBe("connect");
  });

  it("refuses a reply made for another key", () => {
    const app = fakePhantomApp();
    const reply = app.handle(connectUrl({ appUrl: "x", redirect, keys: newLinkKeys() }));
    expect(() => readConnect(reply.searchParams, keys)).toThrow(PhantomLinkError);
  });

  it("says when the person declined, and doesn't echo Phantom's error text", () => {
    const declined = new URLSearchParams({ errorCode: "4001", errorMessage: "User rejected" });
    expect(() => readConnect(declined, keys)).toThrow(/declined/);
    const broken = new URLSearchParams({ errorCode: "-32603", errorMessage: "<script>" });
    expect(() => readConnect(broken, keys)).toThrow(/couldn't finish/);
  });

  it.each(["", "phantom_encryption_public_key=zz&data=zz&nonce=zz", "phantom_encryption_public_key=0OIl"])(
    "refuses a malformed reply (%s)",
    (query) => {
      expect(() => readConnect(new URLSearchParams(query), keys)).toThrow(PhantomLinkError);
    },
  );
});

describe("signTransaction", () => {
  const app = fakePhantomApp((transaction) => `signed-${transaction}`);
  const session = readConnect(app.handle(connectUrl({ appUrl: "x", redirect, keys })).searchParams, keys);

  it("sends the transaction and session encrypted, and reads the signed one back", () => {
    const url = signUrl({ redirect: "https://stoked.example/?phantom=sign", session, transaction: "abc" });
    expect(url.startsWith("https://phantom.com/ul/v1/signTransaction?")).toBe(true);
    expect(url).not.toContain(session.session);
    expect(url).not.toContain(session.keys.secretKey);
    expect(readSigned(app.handle(url).searchParams, session)).toBe("signed-abc");
  });

  it("uses a new nonce each time", () => {
    const nonce = () => new URL(signUrl({ redirect, session, transaction: "abc" })).searchParams.get("nonce");
    expect(nonce()).not.toBe(nonce());
  });

  it("refuses a tampered reply", () => {
    const reply = app.handle(signUrl({ redirect, session, transaction: "abc" }));
    const data = bs58.decode(reply.searchParams.get("data")!);
    data[data.length - 1] = data[data.length - 1]! ^ 1;
    reply.searchParams.set("data", bs58.encode(data));
    expect(() => readSigned(reply.searchParams, session)).toThrow(PhantomLinkError);
  });

  it("refuses a reply with someone else's key", () => {
    const stranger = { ...session, keys: newLinkKeys() };
    const reply = app.handle(signUrl({ redirect, session, transaction: "abc" }));
    expect(() => readSigned(reply.searchParams, stranger)).toThrow(PhantomLinkError);
    expect(nacl.box.publicKeyLength).toBe(32);
  });
});
