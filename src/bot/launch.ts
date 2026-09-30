import { InlineKeyboard } from 'grammy';
import { TxError, describeError } from '../errors.js';
import type { LaunchJob, LaunchOutcome, ProgressEvent } from '../services/launcher.js';
import { failureKeyboard, resultKeyboard } from './keyboards.js';
import type { BotDeps, Target, Ui } from './panel.js';
import { failureText, progressText, resultText } from './texts.js';

const PROGRESS_EDIT_INTERVAL_MS = 1100;

/**
 * Starts the launch pipeline in the background and returns immediately.
 * grammY handles updates one at a time, so a launch that takes tens of seconds (IPFS, confirmations,
 * the dev buy wait) must not run inside the update handler or the whole bot would stall.
 */
export async function startLaunch(target: Target, deps: BotDeps, ui: Ui): Promise<void> {
  const { state } = target;
  const draft = state.draft;
  if (!draft) return;

  const job: LaunchJob = { draft: structuredClone(draft), reviewedFeeRaw: state.reviewedFeeRaw ?? 0n };
  const explorer = ui.explorer(draft.chainId);
  const events: ProgressEvent[] = [];

  state.launching = true;
  state.awaiting = null;
  // The user already confirmed: a failed first render (e.g. a Telegram rate limit) must neither
  // abort the launch nor leave the state stuck on "launching" without a running task.
  try {
    await ui.upsert(target, { text: progressText(events, explorer), keyboard: new InlineKeyboard() });
  } catch (err) {
    deps.log.warn('could not render the initial progress panel', err);
  }

  void runInBackground();

  async function runInBackground(): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    let lastEdit = Date.now();

    const render = async () => {
      timer = null;
      lastEdit = Date.now();
      try {
        await ui.upsert(target, { text: progressText(events, explorer), keyboard: new InlineKeyboard() });
      } catch (err) {
        deps.log.debug('progress edit failed', err);
      }
    };
    // Telegram rate-limits edits; keep at most one per interval but always flush the latest state.
    const onProgress = (event: ProgressEvent) => {
      events.push(event);
      const wait = PROGRESS_EDIT_INTERVAL_MS - (Date.now() - lastEdit);
      if (wait <= 0) return render();
      if (!timer) timer = setTimeout(() => void render(), wait);
    };

    let outcome: LaunchOutcome | undefined;
    let failure: unknown;
    try {
      outcome = await deps.launcher.run(job, onProgress);
    } catch (err) {
      failure = err;
    }
    if (timer) clearTimeout(timer);
    state.launching = false;

    try {
      if (outcome) {
        state.lastDraft = job.draft;
        state.draft = null;
        state.reviewedFeeRaw = null;
        await ui.finish(target, {
          text: resultText(job.draft, outcome, ui.chainName(job.draft.chainId), explorer),
          keyboard: resultKeyboard(),
        });
      } else {
        deps.log.error('launch failed', failure);
        const txHash = failure instanceof TxError ? failure.txHash : undefined;
        await ui.upsert(target, { text: failureText(describeError(failure), txHash, explorer), keyboard: failureKeyboard() });
      }
    } catch (err) {
      // The launch itself is already settled; only reporting failed. Make sure the user still learns the outcome.
      deps.log.error('failed to report launch result', err);
      const message = outcome
        ? `Launch berhasil. Token: ${outcome.token} · tx: ${outcome.launchTx}`
        : `Launch gagal: ${describeError(failure)}`;
      await target.api.sendMessage(target.chatId, message).catch(() => {});
    }
  }
}
