package workbench.collaboration.interfaces.http;

import workbench.collaboration.interfaces.ApiProblem;

/** 共享的有界分页与版本参数解析。路由目录先校验字符形状，服务再校验边界。 */
public final class PageInput {
    private PageInput() {}

    public static int limit(String raw) {
        int value = raw == null ? 50 : Integer.parseInt(raw);
        if (value < 1 || value > 100) throw new ApiProblem(400, "INVALID_REQUEST");
        return value;
    }

    public static long number(String raw, long minimum) {
        if (raw != null && !raw.matches("[0-9]{1,16}")) throw new ApiProblem(400, "INVALID_REQUEST");
        long value;
        try {
            value = raw == null ? 0 : Long.parseLong(raw);
        } catch (NumberFormatException invalid) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        if (value < minimum || value > 9_007_199_254_740_991L) throw new ApiProblem(400, "INVALID_REQUEST");
        return value;
    }
}
