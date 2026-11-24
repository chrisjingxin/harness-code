package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import workbench.collaboration.application.service.KnowledgeWorkflowService;
import workbench.collaboration.application.service.KnowledgeAppService;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.PageInput;

/** 知识提议、审核与保鲜的具名路由；身份始终来自当前登录，不接收客户端角色。 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}")
public class KnowledgeWorkflowController {
    private final KnowledgeWorkflowService workflow;
    private final KnowledgeAppService knowledge;
    public KnowledgeWorkflowController(KnowledgeWorkflowService workflow,KnowledgeAppService knowledge){this.workflow=workflow;this.knowledge=knowledge;}
    private String actor(){return CurrentSession.userId();}
    @PostMapping("/knowledge-proposals") public ResponseEntity<String> create(@PathVariable String workspaceId,@RequestBody String body){return ApiResponses.json(201,workflow.create(actor(),workspaceId,body));}
    @GetMapping("/knowledge-proposals") public ResponseEntity<String> list(@PathVariable String workspaceId,@RequestParam(defaultValue="mine")String view,@RequestParam(required=false)String status,@RequestParam(defaultValue="")String afterId,@RequestParam(required=false)String limit){return ApiResponses.json(200,workflow.list(actor(),workspaceId,view,status,afterId,PageInput.limit(limit)));}
    @GetMapping({"/knowledge-proposals/{proposalId}","/knowledge-proposals/{proposalId}/events"}) public ResponseEntity<String> read(@PathVariable String workspaceId,@PathVariable String proposalId,@RequestParam(defaultValue="")String afterId,@RequestParam(required=false)String limit){return ApiResponses.json(200,workflow.read(actor(),workspaceId,proposalId,afterId,PageInput.limit(limit)));}
    @PutMapping("/knowledge-proposals/{proposalId}") public ResponseEntity<String> edit(@PathVariable String workspaceId,@PathVariable String proposalId,@RequestBody String body){return ApiResponses.json(200,workflow.edit(actor(),workspaceId,proposalId,body));}
    @PostMapping("/knowledge-proposals/{proposalId}/submit") public ResponseEntity<String> submit(@PathVariable String workspaceId,@PathVariable String proposalId,@RequestBody String body){return ApiResponses.json(200,workflow.action(actor(),workspaceId,proposalId,"submit",body));}
    @PostMapping("/knowledge-proposals/{proposalId}/withdraw") public ResponseEntity<String> withdraw(@PathVariable String workspaceId,@PathVariable String proposalId,@RequestBody String body){return ApiResponses.json(200,workflow.action(actor(),workspaceId,proposalId,"withdraw",body));}
    @PostMapping("/knowledge-proposals/{proposalId}/review") public ResponseEntity<String> review(@PathVariable String workspaceId,@PathVariable String proposalId,@RequestBody String body){return ApiResponses.json(200,workflow.review(actor(),workspaceId,proposalId,body));}
    @PostMapping("/knowledge/{knowledgeId}/versions/{versionId}/reads") public ResponseEntity<String> reads(@PathVariable String workspaceId,@PathVariable String knowledgeId,@PathVariable String versionId,@RequestBody String body){return ApiResponses.json(200,workflow.readHit(actor(),workspaceId,knowledgeId,versionId,body));}
    @GetMapping("/knowledge/{knowledgeId}/versions/{versionId}/feedback") public ResponseEntity<String> feedback(@PathVariable String workspaceId,@PathVariable String knowledgeId,@PathVariable String versionId){return ApiResponses.json(200,workflow.feedback(actor(),workspaceId,knowledgeId,versionId));}
    @PutMapping("/knowledge/{knowledgeId}/versions/{versionId}/feedback") public ResponseEntity<String> feedbackWrite(@PathVariable String workspaceId,@PathVariable String knowledgeId,@PathVariable String versionId,@RequestBody String body){return ApiResponses.json(200,workflow.feedback(actor(),workspaceId,knowledgeId,versionId,body));}
    @GetMapping("/knowledge-reviews") public ResponseEntity<String> queue(@PathVariable String workspaceId,@RequestParam(defaultValue="")String afterId,@RequestParam(required=false)String limit){return ApiResponses.json(200,knowledge.reviews(actor(),workspaceId,afterId,PageInput.limit(limit)));}
    @GetMapping("/knowledge/{knowledgeId}/review") public ResponseEntity<String> reviewDetail(@PathVariable String workspaceId,@PathVariable String knowledgeId,@RequestParam(defaultValue="")String afterId,@RequestParam(required=false)String limit){return ApiResponses.json(200,workflow.reviewDetail(actor(),workspaceId,knowledgeId,afterId,PageInput.limit(limit)));}
    @PostMapping("/knowledge/{knowledgeId}/review") public ResponseEntity<String> confirm(@PathVariable String workspaceId,@PathVariable String knowledgeId,@RequestBody String body){return ApiResponses.json(200,workflow.confirm(actor(),workspaceId,knowledgeId,body));}
}
