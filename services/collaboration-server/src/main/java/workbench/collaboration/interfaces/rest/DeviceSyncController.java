package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.ConversationSyncAppService;
import workbench.collaboration.interfaces.http.ApiResponses;

/**
 * 模块：设备会话同步与心跳 REST 控制器 (DeviceSyncController)
 *
 * <p>【功能定义】
 * 设备凭据域端点：主人 Runner 上传定稿消息批次与简报、设备心跳。
 * 上传通道只进不出——Java 校验落库后仅回执水位，无任何下行命令（D1）。
 *
 * <p>【协作边界】
 * - 上游调用方：本机设备 Runner（上传通道）。
 * - 下游依赖方：ConversationSyncAppService、ApiResponses。
 */
@RestController
public class DeviceSyncController {

    private final ConversationSyncAppService sync;

    public DeviceSyncController(ConversationSyncAppService sync) {
        this.sync = sync;
    }

    /** 主人设备上传定稿消息批次与简报。 */
    @PostMapping("/api/v1/device/conversations/{conversationId}/sync")
    public ResponseEntity<String> sync(
            @RequestHeader("Authorization") String authorization,
            @PathVariable String conversationId,
            @RequestBody String body
    ) {
        return ApiResponses.json(200, sync.sync(authorization, conversationId, body));
    }

    /** 设备心跳：刷新在线展示键，返回 204。 */
    @PostMapping("/api/v1/device/heartbeat")
    public ResponseEntity<String> heartbeat(@RequestHeader("Authorization") String authorization) {
        sync.heartbeat(authorization);
        return ResponseEntity.noContent().build();
    }
}
