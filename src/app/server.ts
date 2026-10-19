/**
 * Veto dashboard server.
 *
 * Dependency-free: `node:http`, `node:fs` and the existing policy engine. It
 * serves a small JSON API over a single in-memory `VetoGuard` and the static UI
 * in `src/app/ui/`.
 *
 * Design notes:
 *  - one guard, held in memory, so the demo has one pinned policy, one ledger,
 *    one audit chain. `POST /api/policy/reset` throws it away for a clean demo.
 *  - the API is authoritative: input is validated for shape only, and every
 *    verdict comes from the engine. The server never decides anything itself.
 *  - `/api/preview` is a dry run: nothing is booked, no attempt is recorded, so
 *    pressing Evaluate is free.
 *  - `/api/simulate-attack` runs on a throwaway guard, so an attack demo can
 *    never spend the live budget or dirty the live audit chain.
 *
 * Run: node src/app/server.ts   (PORT=8787 by default)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { VetoGuard } from '../core/service.ts';
import type { ActionRequest, Decision, QuoteSnapshot } from '../core/engine.ts';
import type { ApprovalRequest } from '../core/service.ts';
import { loadIntentsQuote, runAttackScript, type IntentsQuote } from './attack-script.ts';

const APP_DIR = import.meta.dirname;
const ROOT_DIR = resolve(APP_DIR, '..', '..');
const UI_DIR = join(APP_DIR, 'ui');
const POLICY_PATH = join(ROOT_DIR, 'examples', 'policy.yaml');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const RECENT_LIMIT = 25;
const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// State: one guard, one feed, one policy pinned by hash.
// ---------------------------------------------------------------------------

const shippedPolicyText = readFileSync(POLICY_PATH, 'utf8');
const intentsQuote: IntentsQuote = loadIntentsQuote();

let guard = VetoGuard.create({ policyText: shippedPolicyText });

/**
 * A `Decision` deliberately carries no counterparty: the audit record has it, the
 * decision object does not. The feed still needs to show where money would go, so
 * we attach the two fields the UI renders. Nothing in the engine reads them back.
 */
type FeedDecision = Decision & { to: string | null; destinationAddress: string | null };

/** Newest-first feed of decisions the dashboard has seen. Capped so memory is flat. */
let recent: FeedDecision[] = [];

function describeDecision(decision: Decision, action: ActionRequest): FeedDecision {
  return {
    ...decision,
    to: action.to ?? null,
    destinationAddress: action.destinationAddress ?? action.quote?.destinationAddress ?? null,
  };
}

function remember(decision: FeedDecision): void {
  recent = [decision, ...recent].slice(0, RECENT_LIMIT);
}

function resetGuard(reason: string): void {
  guard = VetoGuard.create({ policyText: shippedPolicyText });
  recent = [];
  console.log(`[veto] guard reset (${reason}) -> policy ${guard.policyHash.slice(0, 12)}`);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const STATIC_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': String(body.length) });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${message}\n`, 'utf8');
  res.writeHead(status, {
    ...STATIC_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
  });
  res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        rejectPromise(new HttpError(400, `request body is larger than ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        rejectPromise(new HttpError(400, `request body is not valid JSON: ${(err as Error).message}`));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      rejectPromise(err);
    });
  });
}

function asObject(body: unknown, what: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, `request body must be a JSON object${what ? ` (${what})` : ''}`);
  }
  return body as Record<string, unknown>;
}

function requireString(raw: Record<string, unknown>, field: string, hint?: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `"${field}" is required and must be a non-empty string${hint ? ` (${hint})` : ''}`);
  }
  return value;
}

/** Build an ActionRequest from untrusted JSON, keeping only fields the engine knows. */
function parseAction(body: unknown): ActionRequest {
  const raw = asObject(body, 'an ActionRequest');
  const action: ActionRequest = {
    id: requireString(raw, 'id', 'idempotency key, single use'),
    kind: requireString(raw, 'kind', 'one of near.transfer, ft.transfer, intent.swap, api.pay') as ActionRequest['kind'],
    actor: requireString(raw, 'actor', `the policy agent is ${guard.policyDoc.agent}`),
    asset: requireString(raw, 'asset', 'asset id from the policy, e.g. USDC or NEAR'),
    amount: requireString(raw, 'amount', 'decimal string, e.g. "5" or "1.25"'),
  };
  if (typeof raw.to === 'string' && raw.to.length > 0) action.to = raw.to;
  if (typeof raw.venue === 'string' && raw.venue.length > 0) action.venue = raw.venue;
  if (typeof raw.slippageBps === 'number' && Number.isFinite(raw.slippageBps)) action.slippageBps = raw.slippageBps;
  if (typeof raw.destinationAddress === 'string' && raw.destinationAddress.length > 0) {
    action.destinationAddress = raw.destinationAddress;
  }
  if (typeof raw.destinationAsset === 'string' && raw.destinationAsset.length > 0) {
    action.destinationAsset = raw.destinationAsset;
  }
  if (typeof raw.reason === 'string') action.reason = raw.reason;
  if (typeof raw.requestedAt === 'string') action.requestedAt = raw.requestedAt;
  if (typeof raw.quote === 'object' && raw.quote !== null && !Array.isArray(raw.quote)) {
    action.quote = raw.quote as QuoteSnapshot;
  }
  return action;
}

function approvalSummary(approval: ApprovalRequest): Record<string, unknown> {
  return {
    id: approval.id,
    actionId: approval.actionId,
    kind: approval.action.kind,
    asset: approval.action.asset,
    amount: approval.action.amount,
    to: approval.action.to ?? null,
    status: approval.status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    decidedBy: approval.decidedBy ?? null,
    decidedAt: approval.decidedAt ?? null,
    note: approval.note ?? null,
  };
}

// ---------------------------------------------------------------------------
// Static files: only `/` and `/ui/*`, never outside the ui directory.
// ---------------------------------------------------------------------------

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  let relative: string | null = null;
  if (pathname === '/' || pathname === '/index.html') relative = 'index.html';
  else if (pathname.startsWith('/ui/')) relative = pathname.slice('/ui/'.length);
  else return false;

  if (relative.length === 0) {
    sendText(res, 404, 'not found: expected a file name after /ui/');
    return true;
  }
  // Reject traversal before touching the file system, then verify after resolving.
  if (relative.includes('..') || relative.includes('\\') || relative.includes('\0')) {
    sendText(res, 400, 'bad request: path traversal is not allowed');
    return true;
  }
  const file = resolve(UI_DIR, relative);
  if (file !== UI_DIR && !file.startsWith(`${UI_DIR}${sep}`)) {
    sendText(res, 400, 'bad request: path is outside the ui directory');
    return true;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    sendText(res, 404, `not found: ${pathname}`);
    return true;
  }

  const body = readFileSync(file);
  res.writeHead(200, {
    ...STATIC_HEADERS,
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(body.length),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const method = req.method ?? 'GET';

  if (pathname === '/api/state') {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(400, `GET is required on /api/state (received ${method})`);
    }
    const snapshot = guard.snapshot();
    const decided = snapshot.approvals.filter((approval) => approval.status !== 'pending');
    sendJson(res, 200, {
      now: new Date().toISOString(),
      policyHash: guard.policyHash,
      policy: guard.policyDoc,
      summary: guard.summary(),
      approvals: guard.pendingApprovals.map(approvalSummary),
      approvalsDecided: decided.slice(-8).reverse().map(approvalSummary),
      audit: guard.verifyAudit(),
      recent,
      intentsQuote,
    });
    return;
  }

  if (pathname === '/api/audit') {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(400, `GET is required on /api/audit (received ${method})`);
    }
    const records = guard.snapshot().audit;
    sendJson(res, 200, {
      policyHash: guard.policyHash,
      verification: guard.verifyAudit(),
      count: records.length,
      records,
    });
    return;
  }

  if (pathname === '/api/actions') {
    if (method !== 'POST') throw new HttpError(400, `POST is required on /api/actions (received ${method})`);
    const action = parseAction(await readJsonBody(req));
    const result = await guard.submit(action);
    const decision = describeDecision(result.decision, action);
    remember(decision);
    console.log(
      `[veto] submit ${action.kind} ${action.amount} ${action.asset}${action.to ? ` -> ${action.to}` : ''} => ${result.decision.verdict}` +
        `${result.approval ? ` (approval ${result.approval.id})` : ''}`,
    );
    sendJson(res, 200, {
      decision,
      approval: result.approval ? approvalSummary(result.approval) : null,
      execution: result.execution,
      policyHash: guard.policyHash,
    });
    return;
  }

  if (pathname === '/api/preview') {
    if (method !== 'POST') throw new HttpError(400, `POST is required on /api/preview (received ${method})`);
    const action = parseAction(await readJsonBody(req));
    // Dry run: preview() reads the ledger and never reserves, books or audits.
    const decision = describeDecision(guard.preview(action), action);
    sendJson(res, 200, { decision, approval: null, execution: null, preview: true, policyHash: guard.policyHash });
    return;
  }

  if (pathname === '/api/simulate-attack') {
    if (method !== 'POST') throw new HttpError(400, `POST is required on /api/simulate-attack (received ${method})`);
    const run = await runAttackScript({ policyText: shippedPolicyText, quote: intentsQuote });
    console.log(
      `[veto] attack simulator: ${run.count} cases, ${run.denied} denied, ${run.allowed} allowed, ${run.mismatches} mismatches`,
    );
    sendJson(res, 200, run);
    return;
  }

  if (pathname === '/api/policy/reset') {
    if (method !== 'POST') throw new HttpError(400, `POST is required on /api/policy/reset (received ${method})`);
    resetGuard('POST /api/policy/reset');
    sendJson(res, 200, {
      ok: true,
      policyHash: guard.policyHash,
      policy: guard.policyDoc,
      note: 'reloaded examples/policy.yaml into a fresh guard; ledger, approvals and audit chain are empty again',
    });
    return;
  }

  const approvalRoute = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (approvalRoute) {
    const approvalId = approvalRoute[1];
    const verb = approvalRoute[2];
    if (method !== 'POST') {
      throw new HttpError(400, `POST is required on ${pathname} (received ${method})`);
    }
    const body = asObject(await readJsonBody(req), 'the approval decision');
    const approver = requireString(body, 'approver', `approvers: ${guard.compiled.approval.approvers.join(', ')}`);

    if (verb === 'approve') {
      const result = await guard.approve(approvalId, approver);
      if (result.status === 'not_found') throw new HttpError(404, `no approval request with id ${approvalId}`);
      if (result.status === 'not_an_approver') {
        throw new HttpError(400, `${approver} is not an approver for this policy (approvers: ${guard.compiled.approval.approvers.join(', ')})`);
      }
      console.log(`[veto] approve ${approvalId} by ${approver} => ${result.status}`);
      sendJson(res, 200, { status: result.status, decision: result.decision, execution: result.execution });
      return;
    }

    const note = typeof body.note === 'string' && body.note.length > 0 ? body.note : undefined;
    const result = guard.reject(approvalId, approver, note);
    if (result.status === 'not_found') throw new HttpError(404, `no approval request with id ${approvalId}`);
    if (result.status === 'not_an_approver') {
      throw new HttpError(400, `${approver} is not an approver for this policy (approvers: ${guard.compiled.approval.approvers.join(', ')})`);
    }
    console.log(`[veto] reject ${approvalId} by ${approver} => ${result.status}`);
    sendJson(res, 200, { status: result.status, decision: null, execution: null });
    return;
  }

  throw new HttpError(404, `no API route for ${method} ${pathname}`);
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  } catch {
    throw new HttpError(400, 'unparseable request url');
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'request path is not valid percent-encoding');
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }

  if (serveStatic(req, res, pathname)) return;

  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  sendText(res, 404, `not found: ${pathname}`);
}

const server = createServer((req, res) => {
  void dispatch(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'internal server error';
    if (status >= 500) console.error('[veto] request failed:', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, status, { error: message });
  });
});

server.listen(PORT, HOST, () => {
  const agent = guard.policyDoc.agent;
  const owner = guard.policyDoc.owner;
  console.log(`Veto dashboard listening on http://${HOST}:${PORT}`);
  console.log(`  policy  examples/policy.yaml`);
  console.log(`  hash    ${guard.policyHash}`);
  console.log(`  agent   ${agent}   owner ${owner}`);
});

server.on('error', (err: Error) => {
  console.error(`[veto] server error: ${err.message}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[veto] ${signal} received, closing server`);
    server.close(() => process.exit(0));
  });
}

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[veto] unhandled rejection:', reason);
});
