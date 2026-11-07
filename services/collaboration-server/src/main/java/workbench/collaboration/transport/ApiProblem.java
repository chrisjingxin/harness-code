package workbench.collaboration.transport;

/** 用例的安全拒绝；只携带固定业务错误，不携带 SQL、凭据或底层异常正文。 */
public final class ApiProblem extends RuntimeException {
  public final int status;
  public final String code;
  public ApiProblem(int status, String code) { super(code); this.status = status; this.code = code; }
}
