export type EventSubscriber = (latestCursor: number) => void;

/** In-process wake-up fanout; SQLite audit cursors remain the durable source. */
export class HubEventNotifier {
  private readonly subscribers = new Set<EventSubscriber>();

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(latestCursor: number): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(latestCursor);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  get size(): number {
    return this.subscribers.size;
  }
}
