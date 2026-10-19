
      /* ================================================================== *
       * Veto dashboard. One panel, one render function, no frameworks.
       * ================================================================== */

      const $ = (id) => document.getElementById(id);

      const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      const esc = (value) => String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

      const DECIMALS = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
      const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
      const USD = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

      const APPROVER = "alice.near";
      const ATTACKER_DESTINATION = "0xdeadbeef00000000000000000000000000000000";
      const PINNED_DESTINATION = "0x9a1f4b0c2d7e8f6a3b5c1d9e0f2a4b6c8d0e1f3a";

      const view = {
        state: null,
        feed: [],
        attack: null,
        audit: null,
        busy: false,
        refreshing: false,
      };

      /* ------------------------------------------------------------ utils */

      function amountText(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return String(value === undefined || value === null ? "вЂ”" : value);
        return DECIMALS.format(number);
      }

      function shortHash(hash, length = 12) {
        if (typeof hash !== "string" || hash.length === 0) return "вЂ”";
        return hash.length <= length ? hash : `${hash.slice(0, length)}вЂ¦`;
      }

      function shortId(id) {
        return typeof id === "string" && id.length > 14 ? `${id.slice(0, 10)}вЂ¦` : String(id || "вЂ”");
      }

      function clockTime(iso) {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour12: false });
      }

      function ago(iso) {
        const stamp = Date.parse(iso);
        if (!Number.isFinite(stamp)) return "";
        const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
        if (seconds < 5) return "just now";
        if (seconds < 60) return `in ${seconds}s`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `in ${minutes}m`;
        return `in ${Math.round(minutes / 60)}h`;
      }

      function since(iso) {
        const stamp = Date.parse(iso);
        if (!Number.isFinite(stamp)) return "";
        const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
        if (seconds < 5) return "just now";
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        return `${Math.round(minutes / 60)}h ago`;
      }

      function verdictClass(verdict) {
        if (verdict === "require_approval") return "approval";
        return verdict === "allow" ? "allow" : "deny";
      }

      function verdictLabel(verdict) {
        if (verdict === "allow") return "ALLOW";
        if (verdict === "require_approval") return "NEEDS APPROVAL";
        return "DENY";
      }

      function verdictChip(verdict, extra) {
        const kind = verdictClass(verdict);
        return `<span class="chip ${kind}">${esc(verdictLabel(verdict))}${extra ? ` В· ${esc(extra)}` : ""}</span>`;
      }

      let toastTimer = null;
      function toast(message, kind = "info") {
        const node = $("toast");
        node.textContent = message;
        node.dataset.kind = kind;
        node.classList.add("show");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("show"), 4600);
      }

      function setConnection(state, detail) {
        const dot = $("conn-dot");
        dot.dataset.state = state;
        $("conn-text").textContent = state === "live" ? "live В· guard attached" : state === "down" ? "offline" : "connectingвЂ¦";
        if (detail) dot.title = detail;
      }

      /* -------------------------------------------------------------- api */

      async function api(path, options = {}) {
        const init = { method: options.method || "GET", headers: {} };
        if (options.body !== undefined) {
          init.method = options.method || "POST";
          init.headers["content-type"] = "application/json";
          init.body = JSON.stringify(options.body);
        }
        let response;
        try {
          response = await fetch(path, init);
        } catch (error) {
          throw new Error(`network error: ${error.message}`);
        }
        const text = await response.text();
        let payload = null;
        if (text.length > 0) {
          try {
            payload = JSON.parse(text);
          } catch {
            throw new Error(`server returned non-JSON (HTTP ${response.status})`);
          }
        }
        if (!response.ok) {
          const detail = payload && payload.error ? payload.error : `HTTP ${response.status}`;
          throw new Error(detail);
        }
        return payload;
      }

      /* ------------------------------------------------------- policy panel */

      function renderPolicy(state) {
        const policy = state.policy || {};
        const limits = policy.limits || {};
        const perTx = limits.perTx || {};
        const daily = limits.daily || {};
        const monthly = limits.monthly || {};
        const assets = [...new Set([...Object.keys(perTx), ...Object.keys(daily), ...Object.keys(monthly)])].sort();

        const limitRows = assets
          .map(
            (asset) => `<tr>
              <td>${esc(asset)}</td>
              <td>${perTx[asset] !== undefined ? esc(amountText(perTx[asset])) : '<span class="dim">вЂ”</span>'}</td>
              <td>${daily[asset] !== undefined ? esc(amountText(daily[asset])) : '<span class="dim">вЂ”</span>'}</td>
              <td>${monthly[asset] !== undefined ? esc(amountText(monthly[asset])) : '<span class="dim">вЂ”</span>'}</td>
            </tr>`,
          )
          .join("");

        const counterparties = policy.counterparties || {};
        const allow = (counterparties.allow || []).map((account) => `<span class="pill">${esc(account)}</span>`).join("");
        const deny = (counterparties.deny || []).map((account) => `<span class="pill bad">${esc(account)}</span>`).join("");
        const approvals = policy.approvals || {};
        const approvers = (approvals.approvers || []).map((account) => esc(account)).join(", ") || "вЂ”";
        const velocity = policy.velocity || {};
        const intents = policy.intents || {};
        const thresholdUsd = approvals.thresholdUsd;
        const actions = policy.actions || {};

        $("policy-mode").textContent = counterparties.mode === "open" ? "open mode" : "strict counterparties";
        $("policy-body").innerHTML = `
          <div class="policy-name">${esc(policy.name || "unnamed policy")}</div>
          <div class="id-row"><span class="k">owner</span><span class="v">${esc(policy.owner || "вЂ”")}</span></div>
          <div class="id-row"><span class="k">agent</span><span class="v">${esc(policy.agent || "вЂ”")}</span></div>

          <div class="subhead">Limits</div>
          <table class="limits">
            <thead>
              <tr><th>asset</th><th>per tx</th><th>daily</th><th>monthly</th></tr>
            </thead>
            <tbody>${limitRows || '<tr><td colspan="4" class="dim">no limits configured</td></tr>'}</tbody>
          </table>
          ${limits.defaultPerTxUsd !== undefined ? `<div class="id-row"><span class="k">default per tx</span><span class="v">$${esc(amountText(limits.defaultPerTxUsd))}</span></div>` : ""}

          <div class="subhead">Allow list</div>
          <div>${allow || '<span class="dim">anyone (open mode)</span>'}</div>

          <div class="subhead">Deny list</div>
          <div>${deny || '<span class="dim">nobody</span>'}</div>

          <div class="subhead">Human approval</div>
          <div class="id-row"><span class="k">above</span><span class="v">${thresholdUsd !== undefined ? `$${esc(amountText(thresholdUsd))}` : "never"}</span></div>
          <div class="id-row"><span class="k">approvers</span><span class="v">${approvers}</span></div>
          <div class="id-row"><span class="k">request ttl</span><span class="v">${approvals.ttlSeconds !== undefined ? `${WHOLE.format(approvals.ttlSeconds)}s` : "вЂ”"}</span></div>

          <div class="subhead">Velocity &amp; intents</div>
          <div class="id-row"><span class="k">max tx / hour</span><span class="v">${velocity.maxTxPerHour !== undefined ? WHOLE.format(velocity.maxTxPerHour) : "вЂ”"}</span></div>
          <div class="id-row"><span class="k">min gap</span><span class="v">${velocity.minIntervalSeconds !== undefined ? `${WHOLE.format(velocity.minIntervalSeconds)}s` : "вЂ”"}</span></div>
          <div class="id-row"><span class="k">swap venue</span><span class="v">${esc((intents.venues || []).join(", ") || "вЂ”")}</span></div>
          <div class="id-row"><span class="k">max slippage</span><span class="v">${intents.maxSlippageBps !== undefined ? `${WHOLE.format(intents.maxSlippageBps)} bps` : "вЂ”"}</span></div>
          <div class="id-row"><span class="k">swap destination</span><span class="v" title="${esc((intents.allowedDestinations || []).join(", "))}">${esc(shortHash((intents.allowedDestinations || [])[0] || "вЂ”", 10))}</span></div>
          <div class="id-row"><span class="k">allowed kinds</span><span class="v">${WHOLE.format((actions.allow || []).length)}</span></div>

          <p class="note">
            The policy hash is what the audit chain commits to: every record stores <code>${esc(shortHash(state.policyHash, 10))}</code>,
            so editing a limit after the fact breaks verification instead of quietly widening the walls.
          </p>
        `;
      }

      /* ----------------------------------------------------- decision feed */

      function describeRecipient(decision) {
        if (decision.kind === "intent.swap") {
          const destination = decision.destinationAddress;
          return destination ? `в†’ ${shortHash(destination, 14)}` : "в†’ no destination";
        }
        return decision.to ? `в†’ ${decision.to}` : "в†’ no recipient";
      }

      function renderCheck(check) {
        return `<li class="${check.passed ? "pass" : "fail"}">
          <span class="mk">${check.passed ? "вњ“" : "вњ—"}</span>
          <span class="ct"><b>${esc(check.title)}</b><span>${esc(check.detail)}</span></span>
        </li>`;
      }

      function renderDecision(entry) {
        const decision = entry.decision || {};
        const kind = verdictClass(decision.verdict);
        const codes = (decision.reasons || [])
          .map((reason) => `<span class="code" title="${esc(reason.message)}">${esc(reason.code)}</span>`)
          .join("");
        const checks = decision.checks || [];
        const failed = checks.filter((check) => !check.passed).length;
        const risk = decision.risk || { level: "low", score: 0 };
        const usd = decision.amountUsdCents ? `в‰€ ${USD.format(Number(decision.amountUsdCents) / 100)}` : null;

        return `<article class="decision ${kind} ${entry.preview ? "preview" : ""}">
          <div class="d-head">
            ${verdictChip(decision.verdict)}
            ${entry.preview ? '<span class="chip ghost">dry run</span>' : ""}
            <span class="d-amount">${esc(amountText(decision.amount))} ${esc(decision.asset)}</span>
            <span class="d-dest">${esc(describeRecipient(decision))}</span>
            <span class="d-time">${esc(clockTime(decision.evaluatedAt))}</span>
          </div>
          <div class="d-meta">
            <span>${esc(decision.kind)}</span>
            <span>${esc(shortId(decision.decisionId))}</span>
            <span>risk ${WHOLE.format(risk.score)} ${esc(risk.level)}</span>
            ${usd ? `<span>${esc(usd)}</span>` : ""}
          </div>
          ${codes ? `<div class="d-codes">${codes}</div>` : ""}
          ${
            checks.length
              ? `<details class="checks"><summary>${WHOLE.format(checks.length)} checks В· ${WHOLE.format(failed)} failed</summary><ul>${checks
                  .map(renderCheck)
                  .join("")}</ul></details>`
              : ""
          }
        </article>`;
      }

      function renderFeed() {
        const feed = $("feed");
        $("feed-count").textContent = view.feed.length ? `${WHOLE.format(view.feed.length)} decisions` : "";
        if (view.feed.length === 0) {
          feed.innerHTML = `<p class="empty">No decisions yet. Send an action above, or run the attack simulator.</p>`;
          return;
        }
        feed.innerHTML = view.feed.map(renderDecision).join("");
      }

      function mergeRecent(list) {
        const incoming = Array.isArray(list) ? list : [];
        const known = new Set(view.feed.map((entry) => entry.decision && entry.decision.decisionId));
        const fresh = incoming.filter((decision) => decision && !known.has(decision.decisionId));
        if (fresh.length === 0) return false;
        view.feed = [...fresh.map((decision) => ({ decision, preview: false })), ...view.feed].slice(0, 40);
        return true;
      }

      function addDecision(decision, preview) {
        if (!decision || !decision.decisionId) return;
        if (view.feed.some((entry) => entry.decision && entry.decision.decisionId === decision.decisionId)) return;
        view.feed = [{ decision, preview: Boolean(preview) }, ...view.feed].slice(0, 40);
      }

      /* -------------------------------------------------------- approvals */

      function renderApprovals(state) {
        const pending = Array.isArray(state.approvals) ? state.approvals : [];
        const decided = Array.isArray(state.approvalsDecided) ? state.approvalsDecided : [];
        const threshold = state.policy && state.policy.approvals ? state.policy.approvals.thresholdUsd : undefined;

        $("approvals-count").textContent = pending.length ? `${WHOLE.format(pending.length)} waiting` : "queue clear";
        $("approvals-count").className = pending.length ? "chip approval" : "chip neutral";

        const host = $("approvals");
        if (pending.length === 0) {
          host.innerHTML = `<p class="empty">Nothing waiting for a human. Requests above ${
            threshold !== undefined ? `$${esc(amountText(threshold))}` : "the threshold"
          } land here and hold their budget until a person decides.</p>`;
        } else {
          host.innerHTML = pending
            .map((approval) => {
              const amount = `${esc(amountText(approval.amount))} ${esc(approval.asset)}`;
              const destination = approval.to ? `в†’ ${esc(approval.to)}` : "no recipient";
              return `<div class="approval-card">
                <div class="a-top">
                  <span class="a-amt">${amount}</span>
                  <span class="d-dest">${destination}</span>
                  ${verdictChip("require_approval")}
                </div>
                <div class="a-meta">${esc(approval.kind)} В· ${esc(shortId(approval.id))} В· expires ${esc(ago(approval.expiresAt))}</div>
                <div class="a-btns">
                  <button class="btn good sm" type="button" data-approval="${esc(approval.id)}" data-verb="approve">Approve</button>
                  <button class="btn danger sm" type="button" data-approval="${esc(approval.id)}" data-verb="reject">Reject</button>
                  <span class="a-who">as ${esc(APPROVER)}</span>
                </div>
              </div>`;
            })
            .join("");
        }

        const history = $("decided");
        if (decided.length === 0) {
          history.innerHTML = "";
        } else {
          history.innerHTML = `<div class="decided">${decided
            .slice(0, 5)
            .map(
              (approval) => `<div class="decided-row">
                <span>${esc(amountText(approval.amount))} ${esc(approval.asset)} В· ${esc(approval.status)}</span>
                <span>${esc(approval.decidedBy || "вЂ”")} В· ${esc(since(approval.decidedAt))}</span>
              </div>`,
            )
            .join("")}</div>`;
        }
      }

      /* ---------------------------------------------------------- budgets */

      function renderBudgets(state) {
        const rows = Array.isArray(state.summary) ? state.summary : [];
        const host = $("budgets");
        if (rows.length === 0) {
          host.innerHTML = `<p class="empty">No spend limits in this policy.</p>`;
          return;
        }
        host.innerHTML = rows
          .map((row) => {
            const daily = row.daily;
            if (!daily) {
              return `<div class="budget">
                <div class="b-head"><span class="b-asset">${esc(row.asset)}</span><span class="b-nums">per tx ${esc(amountText(row.perTx || "вЂ”"))}</span></div>
                <div class="b-sub"><span>no daily budget</span><span>monthly ${row.monthly ? `${esc(amountText(row.monthly.spent))} / ${esc(amountText(row.monthly.limit))}` : "вЂ”"}</span></div>
              </div>`;
            }
            const spent = Number(daily.spent) + Number(daily.reserved);
            const limit = Number(daily.limit);
            const used = limit > 0 ? Math.min(100, Math.max(0, (spent / limit) * 100)) : 0;
            const tone = used >= 100 ? "full" : used >= 75 ? "warn" : "";
            return `<div class="budget">
              <div class="b-head">
                <span class="b-asset">${esc(row.asset)}</span>
                <span class="b-nums">${esc(amountText(daily.spent))}${Number(daily.reserved) > 0 ? ` + ${esc(amountText(daily.reserved))} held` : ""} / ${esc(amountText(daily.limit))}</span>
              </div>
              <div class="track"><div class="fill ${tone}" style="width:${used.toFixed(1)}%"></div></div>
              <div class="b-sub">
                <span>remaining ${esc(amountText(daily.remaining))}</span>
                <span>monthly ${row.monthly ? `${esc(amountText(row.monthly.spent))} / ${esc(amountText(row.monthly.limit))}` : "вЂ”"} В· per tx ${esc(amountText(row.perTx || "вЂ”"))}</span>
              </div>
            </div>`;
          })
          .join("");
      }

      /* --------------------------------------------------------- attacks */

      function renderAttack(run) {
        view.attack = run;
        const results = Array.isArray(run.results) ? run.results : [];
        const host = $("attack-body");
        if (results.length === 0) {
          host.innerHTML = `<p class="empty">The simulator returned no cases.</p>`;
          return;
        }
        const rows = results
          .map((entry, index) => {
            const kind = verdictClass(entry.verdict);
            const codes = (entry.codes || []).map((code) => `<span class="code">${esc(code)}</span>`).join("");
            const mismatch = entry.matchesExpectation === false ? ' <span class="chip deny">unexpected</span>' : "";
            return `<tr class="${kind}">
              <td class="a-idx">${String(index + 1).padStart(2, "0")}</td>
              <td>
                <div class="a-name">${esc(entry.name)}${mismatch}</div>
                <div class="a-subject">${esc(entry.subject)}</div>
              </td>
              <td>${verdictChip(entry.verdict)}</td>
              <td><div class="a-wall">${esc(entry.wall)}</div></td>
              <td><div class="a-codes">${codes || '<span class="code ok">clean</span>'}</div></td>
            </tr>`;
          })
          .join("");

        host.innerHTML = `
          <div class="attack-summary">
            ${verdictChip("deny")}
            <span><b>${WHOLE.format(run.denied)}</b> of ${WHOLE.format(run.count)} refused</span>
            <span class="dim">В·</span>
            ${verdictChip("allow")}
            <span><b>${WHOLE.format(run.allowed)}</b> legitimate payment let through</span>
            <span class="dim">В·</span>
            <span class="hint">${run.mismatches === 0 ? "every case landed where the catalogue says it should" : `${WHOLE.format(run.mismatches)} case(s) did not match expectations`}</span>
          </div>
          <div class="attack-scroll">
            <table class="attack">
              <thead>
                <tr><th>#</th><th>Attack</th><th>Verdict</th><th>Wall it hit</th><th>Reason codes</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <p class="note">${esc(run.policyNote || "")}</p>
        `;
      }

      async function runAttack() {
        const button = $("run-attack");
        button.disabled = true;
        button.textContent = "RunningвЂ¦";
        try {
          const run = await api("/api/simulate-attack", { method: "POST" });
          renderAttack(run);
          toast(`${WHOLE.format(run.denied)} of ${WHOLE.format(run.count)} attacks refused, ${WHOLE.format(run.allowed)} legitimate payment allowed`, "good");
        } catch (error) {
          toast(`attack simulator failed: ${error.message}`, "bad");
        } finally {
          button.disabled = false;
          button.textContent = "Run attack sequence";
        }
      }

      /* ----------------------------------------------------------- audit */

      function renderAudit(verification, hash) {
        $("audit-records").textContent = verification ? `${WHOLE.format(verification.records)} records` : "вЂ”";
        const head = $("audit-head");
        head.textContent = verification ? shortHash(verification.head, 16) : "вЂ”";
        head.title = verification ? verification.head : "";
        $("audit-policy").textContent = shortHash(hash, 12);
        const status = $("audit-status");
        if (!verification) {
          status.innerHTML = '<span class="chip neutral">not checked</span>';
          return;
        }
        status.innerHTML = verification.ok
          ? '<span class="chip allow">verified</span>'
          : `<span class="chip deny">broken at #${WHOLE.format(verification.brokenAt || 0)}</span>`;
      }

      async function verifyChain() {
        const button = $("verify-chain");
        button.disabled = true;
        try {
          const audit = await api("/api/audit");
          view.audit = audit;
          renderAudit(audit.verification, audit.policyHash);
          if (audit.verification.ok) {
            toast(`chain verified: ${WHOLE.format(audit.count)} records, head ${shortHash(audit.verification.head, 12)}`, "good");
          } else {
            toast(`chain broken at record #${audit.verification.brokenAt}: ${audit.verification.reason || "hash mismatch"}`, "bad");
          }
        } catch (error) {
          toast(`verify failed: ${error.message}`, "bad");
        } finally {
          button.disabled = false;
        }
      }

      async function resetDemo() {
        const button = $("reset-policy");
        button.disabled = true;
        try {
          const result = await api("/api/policy/reset", { method: "POST" });
          view.feed = [];
          view.attack = null;
          renderFeed();
          $("attack-body").innerHTML = `<p class="empty">Fresh guard. Run the attack sequence to fill this panel again.</p>`;
          toast(`policy reloaded: ${shortHash(result.policyHash, 12)} В· ledger, approvals and audit chain cleared`, "good");
          await refreshState();
        } catch (error) {
          toast(`reset failed: ${error.message}`, "bad");
        } finally {
          button.disabled = false;
        }
      }

      /* ------------------------------------------------------------ form */

      function currentQuote() {
        const quote = (view.state && view.state.intentsQuote) || {};
        return {
          venue: "near-intents",
          originAsset: $("asset").value,
          destinationAsset: quote.destinationAsset || "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
          amountIn: quote.amountIn || "1000000000000000000000000",
          amountOut: quote.amountOut || "4914535",
          minAmountOut: quote.minAmountOut || "4889962",
          slippageBps: 50,
          destinationAddress: $("tamper").checked ? ATTACKER_DESTINATION : PINNED_DESTINATION,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        };
      }

      function buildAction(preview) {
        const kind = $("kind").value;
        const asset = $("asset").value;
        const amount = $("amount").value.trim();
        const recipient = $("recipient").value.trim();
        const actor = (view.state && view.state.policy && view.state.policy.agent) || "argo.near";

        if (amount.length === 0) {
          toast("amount is required", "bad");
          return null;
        }

        const action = {
          id: `${preview ? "ui_preview" : "ui"}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          kind,
          actor,
          asset,
          amount,
          requestedAt: new Date().toISOString(),
          reason: "submitted from the Veto dashboard",
        };

        if (kind === "intent.swap") {
          action.venue = "near-intents";
          action.slippageBps = 50;
          action.destinationAddress = $("tamper").checked ? ATTACKER_DESTINATION : PINNED_DESTINATION;
          action.quote = currentQuote();
        } else if (recipient.length > 0) {
          action.to = recipient;
        }
        return action;
      }

      function setBusy(busy) {
        view.busy = busy;
        $("send").disabled = busy;
        $("evaluate").disabled = busy;
        $("send").textContent = busy ? "SendingвЂ¦" : "Send to policy";
      }

      async function submitAction(preview) {
        if (view.busy) return;
        const action = buildAction(preview);
        if (!action) return;
        setBusy(true);
        try {
          const endpoint = preview ? "/api/preview" : "/api/actions";
          const result = await api(endpoint, { method: "POST", body: action });
          if (result && result.decision) {
            addDecision(result.decision, preview);
            renderFeed();
            const decision = result.decision;
            if (result.approval) {
              toast(`queued for approval: ${shortId(result.approval.id)} вЂ” a human has to co-sign`, "warn");
            } else if (preview) {
              toast(`dry run: ${verdictLabel(decision.verdict)} В· nothing booked`, "info");
            } else if (decision.verdict === "deny") {
              toast(`denied: ${(decision.reasons || []).map((reason) => reason.code).join(", ") || "policy refusal"}`, "bad");
            } else {
              toast(`allowed and booked: ${amountText(decision.amount)} ${decision.asset}`, "good");
            }
          }
          await refreshState();
        } catch (error) {
          toast(error.message, "bad");
        } finally {
          setBusy(false);
        }
      }

      function applyPreset(name) {
        const presets = {
          small: { kind: "ft.transfer", asset: "USDC", amount: "5", recipient: "compute.near", tamper: false },
          over: { kind: "ft.transfer", asset: "USDC", amount: "26", recipient: "compute.near", tamper: false },
          drainer: { kind: "ft.transfer", asset: "USDC", amount: "5", recipient: "drainer.near", tamper: false },
          swap: { kind: "intent.swap", asset: "NEAR", amount: "1", recipient: "compute.near", tamper: false },
        };
        const preset = presets[name];
        if (!preset) return;
        $("kind").value = preset.kind;
        $("asset").value = preset.asset;
        $("amount").value = preset.amount;
        $("recipient").value = preset.recipient;
        $("tamper").checked = preset.tamper;
        updateFormForKind();
      }

      function updateFormForKind() {
        const isSwap = $("kind").value === "intent.swap";
        $("recipient-row").classList.toggle("hidden", isSwap);
        $("swap-row").classList.toggle("hidden", !isSwap);
        $("form-hint").textContent = isSwap
          ? "Swaps are checked against the 1Click quote, the venue, slippage and the pinned destination."
          : "Evaluate is a dry run: it never books a spend.";
        $("swap-dest").textContent = $("tamper").checked ? `${shortHash(ATTACKER_DESTINATION, 14)} (tampered)` : `${shortHash(PINNED_DESTINATION, 14)} (pinned)`;
      }

      /* -------------------------------------------------------- approvals */

      async function decideApproval(id, verb) {
        const buttons = document.querySelectorAll(`button[data-approval="${id}"]`);
        buttons.forEach((button) => (button.disabled = true));
        try {
          const result = await api(`/api/approvals/${encodeURIComponent(id)}/${verb}`, {
            method: "POST",
            body: verb === "approve" ? { approver: APPROVER } : { approver: APPROVER, note: "rejected from the dashboard" },
          });
          const status = (result && result.status) || "unknown";
          if (status === "executed") toast(`approved by ${APPROVER}: re-checked against the policy and executed`, "good");
          else if (status === "rejected") toast("rejected вЂ” the reservation is released and the budget is free again", "warn");
          else if (status === "recheck_failed") toast("approval re-check failed: the policy tightened since this request", "bad");
          else if (status === "expired") toast("that approval already expired", "warn");
          else toast(`approval ${status}`, status === "executed" ? "good" : "warn");
          await refreshState();
        } catch (error) {
          toast(error.message, "bad");
          buttons.forEach((button) => (button.disabled = false));
        }
      }

      /* ------------------------------------------------------- state load */

      function renderAll() {
        const state = view.state;
        if (!state) return;
        $("policy-hash").textContent = shortHash(state.policyHash, 12);
        $("policy-hash").title = state.policyHash;
        $("agent-name").textContent = (state.policy && state.policy.agent) || "argo.near";
        if (state.intentsQuote && state.intentsQuote.amountOutFormatted) {
          $("foot-quote").textContent = `1 NEAR в†’ ${amountText(state.intentsQuote.amountOutFormatted)} USDC`;
        }
        renderPolicy(state);
        renderApprovals(state);
        renderBudgets(state);
        renderAudit(state.audit, state.policyHash);
      }

      async function refreshState() {
        if (view.refreshing) return;
        view.refreshing = true;
        try {
          const state = await api("/api/state");
          view.state = state;
          mergeRecent(state.recent);
          renderAll();
          renderFeed();
          setConnection("live");
        } catch (error) {
          setConnection("down", error.message);
        } finally {
          view.refreshing = false;
        }
      }

      /* -------------------------------------------------------------- init */

      function bind() {
        $("kind").addEventListener("change", updateFormForKind);
        $("tamper").addEventListener("change", updateFormForKind);
        $("send").addEventListener("click", () => submitAction(false));
        $("evaluate").addEventListener("click", () => submitAction(true));
        $("run-attack").addEventListener("click", runAttack);
        $("verify-chain").addEventListener("click", verifyChain);
        $("reset-policy").addEventListener("click", resetDemo);

        $("copy-hash").addEventListener("click", async () => {
          const hash = (view.state && view.state.policyHash) || "";
          if (!hash) return;
          try {
            await navigator.clipboard.writeText(hash);
            toast("policy hash copied", "good");
          } catch {
            toast("copy failed вЂ” the full hash is in the tooltip", "warn");
          }
        });

        document.querySelectorAll(".preset").forEach((button) => {
          button.addEventListener("click", () => applyPreset(button.dataset.preset));
        });

        $("approvals").addEventListener("click", (event) => {
          const button = event.target.closest("button[data-approval]");
          if (!button) return;
          decideApproval(button.dataset.approval, button.dataset.verb);
        });

        $("amount").addEventListener("keydown", (event) => {
          if (event.key === "Enter") submitAction(false);
        });
        $("recipient").addEventListener("keydown", (event) => {
          if (event.key === "Enter") submitAction(false);
        });
      }

      function init() {
        bind();
        updateFormForKind();
        renderFeed();
        refreshState();
        setInterval(refreshState, 4000);
        window.addEventListener("focus", refreshState);
      }

      init();
    
