export function setReportDir() {}
export function reportDir() { return "reports"; }
export function writeRunning() {}
export function writeSnapshot() {}
export function formatPartial() { return ""; }
export async function readServerSnapshot() { return { activity: [], locks: [] }; }
export async function captureActivity() { return { activity: [], locks: [] }; }
export function installKillSnapshot() {}
export function startActivityLoop() { return () => {}; }
