package workbench.collaboration.domain.task;

import workbench.collaboration.interfaces.ApiProblem;

/** 任务状态及合法流转。编码 1–5 对应数据库中的固定值。 */
public enum TaskStatus {
    TODO(1, "todo"), DOING(2, "doing"), REVIEW(3, "review"), DONE(4, "done"), CANCELLED(5, "cancelled");

    public final int code;
    public final String wire;

    TaskStatus(int code, String wire) {
        this.code = code;
        this.wire = wire;
    }

    public static TaskStatus fromCode(int code) {
        for (var status : values()) {
            if (status.code == code) return status;
        }
        throw new IllegalArgumentException("未知任务状态码: " + code);
    }

    public static TaskStatus parse(String wire) {
        for (var status : values()) {
            if (status.wire.equals(wire)) return status;
        }
        throw new ApiProblem(400, "INVALID_REQUEST");
    }

    /** 先判断合法边，再校验操作角色。已结束的任务没有出边。 */
    public void requireTransition(TaskStatus target, boolean creator, boolean assignee) {
        if (target == CANCELLED && this != DONE && this != CANCELLED) {
            requireRole(creator);
        } else if ((this == TODO && target == DOING) || (this == DOING && target == REVIEW)) {
            requireRole(assignee);
        } else if (this == REVIEW && (target == TODO || target == DONE)) {
            requireRole(creator);
        } else {
            throw new ApiProblem(409, "TASK_STATE_CONFLICT");
        }
    }

    public static void requireRole(boolean matches) {
        if (!matches) throw new ApiProblem(403, "TASK_ROLE_REQUIRED");
    }
}
