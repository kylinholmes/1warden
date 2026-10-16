/** Bound read-only work. This does not cancel work and must not wrap mutations. */
export async function withReadTimeout<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
