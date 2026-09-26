import type { Lane, Scored, Store } from "./types.ts";

export interface DeliverOptions {
  limit: number;
  send: (md: string) => Promise<void>;
  now: string;
  /** Renders the digest markdown from the top undelivered items. Defaults to a simple list. */
  render?: (scored: Scored[]) => string;
}

function defaultRender(scored: Scored[]): string {
  return scored.map((s) => `- ${s.item.text}`).join("\n");
}

/**
 * Sends only undelivered top items, once. Marks them delivered only after
 * `send` resolves; if `send` throws, nothing is marked.
 */
export async function deliver(store: Store, lane: Lane, opts: DeliverOptions): Promise<number> {
  const items = store.undelivered(lane, opts.limit);
  if (items.length === 0) return 0;

  const render = opts.render ?? defaultRender;
  const md = render(items);

  await opts.send(md);

  store.markDelivered(
    lane,
    items.map((s) => s.item.id),
    opts.now,
  );
  return items.length;
}
