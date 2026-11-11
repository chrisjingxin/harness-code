package workbench.collaboration.project;

import workbench.collaboration.device.DeviceDtos.ReadableProject;

/**
 * 由受信服务端提供项目来源和当前用户的读取授权。
 * 内网接入负责绑定平台实例、仓库与用户身份，无法核验时返回相应原因。
 */
public interface ProjectReadAccess {
  enum Decision { ALLOW, SOURCE_UNKNOWN, IDENTITY_UNBOUND, REPOSITORY_DENIED, AUTH_UNAVAILABLE }
  Decision authorize(String currentUserId, ReadableProject project);
}
