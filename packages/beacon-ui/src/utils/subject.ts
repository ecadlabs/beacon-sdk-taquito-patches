export interface Subscription {
  unsubscribe: () => void
}

export class Subject<T> {
  private subscribers: ((value: T) => void)[] = []
  private latestValue: T | undefined = undefined
  private emitted = false

  public subscribe(callback: (value: T) => void): Subscription {
    this.subscribers.push(callback)
    if (this.emitted) {
      callback(this.latestValue as T)
    }

    const unsubscribe = () => {
      this.unsubscribe(callback)
    }

    return { unsubscribe }
  }

  private unsubscribe(observer: (value: T) => void): void {
    this.subscribers = this.subscribers.filter((subscriber) => subscriber !== observer)
  }

  public next(value: T): void {
    this.latestValue = value
    this.emitted = true
    this.subscribers.forEach((callback) => callback(value))
  }

  public getValue(): T | undefined {
    return this.latestValue
  }

  public hasEmitted(): boolean {
    return this.emitted
  }
}
