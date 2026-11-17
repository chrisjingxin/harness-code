package workbench.collaboration.infrastructure.messaging;

import org.springframework.stereotype.Component;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/** 本进程的通知唤醒信号。流先记录信号版本，再查库，避免在查询和等待之间错过唤醒。 */
@Component
public class NotificationSignal {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private volatile long generation;

    public long generation() {
        return generation;
    }

    public void wake() {
        lock.lock();
        try {
            generation++;
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    public void await(long seen) throws InterruptedException {
        lock.lockInterruptibly();
        try {
            if (seen == generation) changed.await(2, TimeUnit.SECONDS);
        } finally {
            lock.unlock();
        }
    }
}
