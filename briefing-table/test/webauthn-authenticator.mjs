/**
 * A SOFTWARE PLATFORM AUTHENTICATOR, for tests only (E15).
 *
 * Windows Hello cannot be driven from a test, and Playwright's virtual
 * authenticator only exists inside a browser — so the only way to prove the
 * passkey path end to end is to BE the authenticator: hold a P-256 key, build
 * the attestation and the assertion by hand, and let the real engine and the
 * real `@simplewebauthn/server` verify them. That is what this is. It knows
 * nothing about our routes; it speaks WebAuthn, and everything it produces is
 * exactly the JSON a browser would POST.
 *
 * CBOR comes from the library's OWN `isoCBOR` helper rather than a second
 * encoder. Re-implementing it would mean a test that passes because two of my
 * own bugs cancel; borrowing theirs means the bytes this produces are the
 * bytes their decoder expects, and anything left over is genuinely our code.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: attestation beyond `fmt: 'none'` (we ask
 * for none — a homelab has no use for proving which brand of TPM signed), and
 * it never refuses anything. Every refusal under test must come from the
 * engine, or the test is measuring the fixture.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => createHash('sha256').update(buf).digest();

/** A 4-byte big-endian counter, which is how authenticator data carries it. */
function signCountBytes(n) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n >>> 0, 0);
  return out;
}

/**
 * The public key as a COSE_Key map — the format authenticator data carries and
 * the one our `passkey` row stores verbatim. For ES256 that is:
 *   1: 2 (EC2)  ·  3: -7 (ES256)  ·  -1: 1 (P-256)  ·  -2: x  ·  -3: y
 */
function coseKeyFor(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return isoCBOR.encode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ]),
  );
}

export class SoftwareAuthenticator {
  /**
   * @param {object} [opts]
   * @param {Buffer} [opts.aaguid] 16 bytes. Zeroes is what a real platform
   *   authenticator reports when it declines to identify its make and model.
   */
  constructor(opts = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.aaguid = opts.aaguid ?? Buffer.alloc(16, 0);
    this.credentialId = null;
    this.userHandle = null;
    /** The authenticator's own use count. Advances on every assertion; the
     *  engine banks it and refuses a value that did not move, which is the
     *  clone check. Exposed so a test can wind it BACKWARDS on purpose. */
    this.counter = 0;
  }

  /** Impersonate another authenticator's key material — used to prove that a
   *  correctly-shaped assertion signed by the WRONG key is refused. */
  static withKeyOf(other) {
    const clone = new SoftwareAuthenticator();
    clone.privateKey = createPrivateKey(other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    clone.publicKey = createPublicKey(other.publicKey.export({ type: 'spki', format: 'pem' }));
    return clone;
  }

  /** `navigator.credentials.create` — returns a RegistrationResponseJSON. */
  create(options, { origin, type = 'webauthn.create' } = {}) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }),
      'utf8',
    );
    this.credentialId = Buffer.from(sha256(Buffer.from(options.challenge, 'utf8'))).subarray(0, 32);
    this.userHandle = options.user.id;

    const cose = Buffer.from(coseKeyFor(this.publicKey));
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length, 0);
    const authData = Buffer.concat([
      sha256(Buffer.from(options.rp.id, 'utf8')),
      /* UP | UV | AT. User verification is what a PIN or a fingerprint sets,
       * and our options ask for it as REQUIRED — clearing this bit is how a
       * test proves the engine actually checks. */
      Buffer.from([0x01 | 0x04 | 0x40]),
      signCountBytes(this.counter),
      this.aaguid,
      credIdLen,
      this.credentialId,
      cose,
    ]);
    const attestationObject = Buffer.from(
      isoCBOR.encode(
        new Map([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', new Uint8Array(authData)],
        ]),
      ),
    );

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /**
   * `navigator.credentials.get` — returns an AuthenticationResponseJSON.
   *
   * @param {object} options the PublicKeyCredentialRequestOptionsJSON
   * @param {object} opts
   * @param {string} opts.origin what the browser would put in clientDataJSON
   * @param {number} [opts.counter] override the use count (a value that does
   *   not advance is what the engine must refuse as a clone)
   * @param {boolean} [opts.userVerified] clear the UV bit to test the gate
   */
  get(options, { origin, counter, userVerified = true, type = 'webauthn.get' } = {}) {
    if (counter === undefined) {
      this.counter += 1;
    }
    const used = counter === undefined ? this.counter : counter;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }),
      'utf8',
    );
    const authData = Buffer.concat([
      sha256(Buffer.from(options.rpId, 'utf8')),
      Buffer.from([userVerified ? 0x01 | 0x04 : 0x01]),
      signCountBytes(used),
    ]);
    /* The signature covers authData CONCATENATED WITH the hash of the client
     * data — not the client data itself. Getting this wrong is the classic
     * WebAuthn implementation bug, on both sides. */
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle,
      },
    };
  }
}
