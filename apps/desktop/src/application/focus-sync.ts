/** UI events request a background refresh; sync errors remain in the shared snapshot. */
export function subscribeFocusSync(client: { getSnapshot(): { status: string }; sync(): Promise<void> }, target: EventTarget): () => void {
  const focus = () => {
    if (client.getSnapshot().status === 'unlocked') void client.sync().catch(() => {});
  };
  target.addEventListener('focus', focus);
  return () => target.removeEventListener('focus', focus);
}
