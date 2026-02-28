import { v4 as uuidv4 } from "uuid";
import { addJob, removeJob, updateJobStatus, getJobs } from "./storage.js";
import { mintByContract } from "./copymint.js";

let notifyFn;
const activeTimers = new Map(); // jobId -> timeoutId

export function initScheduler(notifyCallback) {
  notifyFn = notifyCallback;
  restoreJobs();
}

function restoreJobs() {
  const jobs = getJobs().filter(j => j.status === "pending");
  const now = Date.now();

  for (const job of jobs) {
    const delay = job.triggerAt - now;
    if (delay <= 0) {
      // Missed — mark as failed
      updateJobStatus(job.id, "missed");
      continue;
    }
    scheduleTimer(job, delay);
  }

  if (jobs.length > 0) {
    console.log(`[Scheduler] Restored ${jobs.length} pending job(s)`);
  }
}

function scheduleTimer(job, delay) {
  const timerId = setTimeout(async () => {
    await executeJob(job);
  }, delay);
  activeTimers.set(job.id, timerId);
}

async function executeJob(job) {
  try {
    await updateJobStatus(job.id, "running");
    const txHash = await mintByContract(job.contract, job.data, job.value);
    await updateJobStatus(job.id, "done");
    activeTimers.delete(job.id);

    await notifyFn(
      `✅ *Scheduled Mint Executed!*\n\n` +
      `📦 Collection: \`${job.label || job.contract.slice(0, 10) + "..."}\`\n` +
      `🔢 Qty: ${job.quantity || 1}\n` +
      `⛓️ Chain: Ethereum\n` +
      `Tx: \`${txHash?.slice(0, 20)}...\``
    );
  } catch (err) {
    await updateJobStatus(job.id, "failed");
    activeTimers.delete(job.id);
    await notifyFn(`❌ *Scheduled Mint Failed*\n\nError: ${err.message}`);
  }
}

export async function createJob({ label, contract, data, value, quantity, triggerAt }) {
  const job = {
    id: uuidv4(),
    label,
    contract,
    data: data || "0x1249c58b",
    value: value || "0",
    quantity: quantity || 1,
    triggerAt, // Unix ms timestamp
    status: "pending",
    createdAt: Date.now(),
  };

  await addJob(job);

  const delay = triggerAt - Date.now();
  if (delay <= 0) throw new Error("Trigger time is in the past");
  scheduleTimer(job, delay);

  return job;
}

export async function cancelJob(id) {
  const timerId = activeTimers.get(id);
  if (timerId) {
    clearTimeout(timerId);
    activeTimers.delete(id);
  }
  await removeJob(id);
}

export function getPendingJobs() {
  return getJobs().filter(j => j.status === "pending");
}
