package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.RepoBindingAppService;
import workbench.collaboration.interfaces.http.ApiResponses;

/**
 * 模块：设备本机仓库登记 REST 控制器 (DeviceRepoBindingController)
 *
 * <p>【功能定义】
 * 设备凭据域端点：设备向平台声明"本机已克隆某团队仓库"或解除该声明。
 * 只登记 (deviceId, repositoryId) 关联，本机绝对路径绝不上行；
 * 路由不接受请求体（边界层 maxBody=0 直接拒绝带体请求）。
 *
 * <p>【协作边界】
 * - 上游调用方：本机设备代理（上传通道）。
 * - 下游依赖方：RepoBindingAppService。
 */
@RestController
public class DeviceRepoBindingController {

    private final RepoBindingAppService bindings;

    public DeviceRepoBindingController(RepoBindingAppService bindings) {
        this.bindings = bindings;
    }

    /** 登记本机仓库克隆（幂等）。 */
    @PutMapping("/api/v1/device/repo-bindings/{repositoryId}")
    public ResponseEntity<String> bind(
            @RequestHeader("Authorization") String authorization, @PathVariable String repositoryId) {
        bindings.bind(authorization, repositoryId);
        return ApiResponses.json(200, "null");
    }

    /** 解除本机仓库登记。 */
    @DeleteMapping("/api/v1/device/repo-bindings/{repositoryId}")
    public ResponseEntity<String> unbind(
            @RequestHeader("Authorization") String authorization, @PathVariable String repositoryId) {
        bindings.unbind(authorization, repositoryId);
        return ApiResponses.json(200, "null");
    }
}
