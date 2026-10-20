import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import tls from 'node:tls';

export type TlsDiagnosis = 'leaf_only_missing_intermediate' | 'unknown_root' | 'self_signed' | 'expired' | 'hostname_mismatch' | 'ok';
export interface ChainCertificate {
  subject: string; issuer: string; sha256: string; validFrom: string; validTo: string;
  aiaIssuerUrl: string | null; source: 'presented' | 'local_store';
}
export interface TlsChainReport {
  origin: string; diagnosis: TlsDiagnosis; certificates: ChainCertificate[];
  links: Array<{ child: string; issuer: string; verified: boolean }>;
  failingLink: { child: string; issuer: string } | null; hint: string;
  authorized: boolean; authorizationError: string | null;
}
const name = (s: string): string => /(?:^|\n)CN=([^\n]+)/.exec(s)?.[1] ?? s;
const issued = (child: X509Certificate, parent: X509Certificate): boolean =>
  parent.ca && child.checkIssued(parent) && child.verify(parent.publicKey);

/** Diagnostic handshake only. No HTTP request or other application bytes are sent. */
export async function inspectTlsChain(options: {
  origin: string; caFile?: string | null; servername?: string; timeoutMs?: number;
}): Promise<TlsChainReport> {
  const url = new URL(options.origin);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('TLS probe requires an https origin without credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const hostname = options.servername ?? host;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('timeoutMs must be an integer from 1 to 10000');
  const extra = options.caFile ? readFileSync(options.caFile, 'utf8') : '';
  const local = [...tls.rootCertificates, ...(extra.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [])]
    .map((pem) => new X509Certificate(pem));
  if (options.caFile && !extra.includes('-----BEGIN CERTIFICATE-----')) throw new Error('CA file contains no PEM certificates');
  const trusted = new Set(local.map((c) => c.fingerprint256));
  const peer = await new Promise<{ chain: X509Certificate[]; authorized: boolean; error: string | null }>((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(url.port || 443), servername: isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: false, ca: [...tls.rootCertificates, extra].filter(Boolean) });
    const timer = setTimeout(() => socket.destroy(new Error('TLS probe timed out')), timeoutMs);
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
    socket.once('secureConnect', () => {
      try {
        const chain: X509Certificate[] = [];
        const seen = new Set<string>();
        let cert = socket.getPeerCertificate(true);
        while (cert?.raw) {
          const x = new X509Certificate(cert.raw);
          if (seen.has(x.fingerprint256)) break;
          seen.add(x.fingerprint256); chain.push(x);
          cert = cert.issuerCertificate;
        }
        if (!chain.length) throw new Error('Peer supplied no certificate');
        resolve({ chain, authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : null });
      } catch (error) { reject(error); }
      finally { socket.end(); socket.destroy(); }
    });
  });
  const report: TlsChainReport = { origin: url.origin, diagnosis: 'ok', certificates: [], links: [],
    failingLink: null, hint: 'The chain and hostname verify against the local CA store.',
    authorized: peer.authorized, authorizationError: peer.error };
  const fail = (diagnosis: TlsDiagnosis, cert: X509Certificate, hint: string): TlsChainReport => {
    report.diagnosis = diagnosis;
    report.failingLink = { child: name(cert.subject), issuer: name(cert.issuer) };
    report.hint = hint; return report;
  };
  const describe = (current: X509Certificate): ChainCertificate => ({ subject: current.subject, issuer: current.issuer, sha256: current.fingerprint256,
      validFrom: current.validFrom, validTo: current.validTo,
      aiaIssuerUrl: /CA Issuers - URI:([^\n]+)/.exec(current.infoAccess ?? '')?.[1] ?? null,
      source: trusted.has(current.fingerprint256) ? 'local_store' : 'presented' });
  report.certificates = peer.chain.map(describe);
  const seen = new Set<string>();
  let current = peer.chain[0]!;
  while (!seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    if (!report.certificates.some((c) => c.sha256 === current.fingerprint256)) report.certificates.push(describe(current));
    const now = Date.now();
    if (now < Date.parse(current.validFrom) || now > Date.parse(current.validTo))
      return fail('expired', current, `Certificate '${name(current.subject)}' is outside its validity period; renew or replace it.`);
    if (seen.size === 1 && !(isIP(hostname) ? current.checkIP(hostname) : current.checkHost(hostname)))
      return fail('hostname_mismatch', current, `Certificate '${name(current.subject)}' does not cover '${hostname}'; use the matching hostname or replace the certificate.`);
    if (trusted.has(current.fingerprint256)) return report;
    const parent = [...peer.chain, ...local].find((candidate) =>
      candidate.fingerprint256 !== current.fingerprint256 && !seen.has(candidate.fingerprint256) && issued(current, candidate));
    if (parent) {
      report.links.push({ child: name(current.subject), issuer: name(parent.subject), verified: true });
      current = parent; continue;
    }
    report.links.push({ child: name(current.subject), issuer: name(current.issuer), verified: false });
    if (current.checkIssued(current) && current.verify(current.publicKey))
      return fail('self_signed', current, `Append CA '${name(current.subject)}' to upstream.caFile if you trust this self-signed certificate.`);
    const leafOnly = seen.size === 1 && !current.ca;
    return fail(leafOnly ? 'leaf_only_missing_intermediate' : 'unknown_root', current,
      `${leafOnly ? 'The gateway sends the leaf only: export the full chain from the issuer. ' : ''}Append CA '${name(current.issuer)}' to upstream.caFile (and its root).${process.platform === 'win32' ? ' NODE_EXTRA_CA_CERTS is another option.' : ''}`);
  }
  return fail('unknown_root', current, `Append CA '${name(current.issuer)}' to upstream.caFile.`);
}

export function renderTlsChain(report: TlsChainReport): string {
  return [...report.certificates.map((c) => `${c.source}: ${c.subject} <- ${c.issuer}\n  SHA256 ${c.sha256}\n  ${c.validFrom} — ${c.validTo}${c.aiaIssuerUrl ? `\n  AIA ${c.aiaIssuerUrl}` : ''}`),
    ...report.links.map((l) => `${l.verified ? 'verified' : 'FAILED'}: ${l.child} <- ${l.issuer}`),
    `${report.diagnosis}: ${report.hint}`].join('\n');
}
