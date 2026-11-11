package workbench.collaboration.transport;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import workbench.collaboration.Contracts;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;

/** 控制器和请求过滤器共用错误出口，保留同一请求编号和会话失效规则。 */
@RestControllerAdvice
public final class ApiExceptionHandler {
  private final Contracts contracts;
  public ApiExceptionHandler(Contracts contracts) { this.contracts = contracts; }

  @ExceptionHandler(ApiProblem.class)
  public void problem(ApiProblem problem, HttpServletRequest request, HttpServletResponse response) throws IOException {
    WebConfiguration.failure(contracts, request, response, problem.status, problem.code);
  }

  @ExceptionHandler({DataAccessException.class, CannotCreateTransactionException.class})
  public void unavailable(HttpServletRequest request, HttpServletResponse response) throws IOException {
    WebConfiguration.failure(contracts, request, response, 503, "SERVICE_UNAVAILABLE");
  }

  @ExceptionHandler(IllegalArgumentException.class)
  public void invalid(HttpServletRequest request, HttpServletResponse response) throws IOException {
    WebConfiguration.failure(contracts, request, response, 400, "INVALID_REQUEST");
  }
}
