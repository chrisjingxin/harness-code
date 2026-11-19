package workbench.collaboration.infrastructure.contract;

import org.junit.jupiter.api.Test;

/** 契约夹具与实现必须一致。失败时 smoke 自己抛出哪一条没对上。 */
class ContractsTest {
  @Test
  void fixturesMatch() {
    new Contracts().smoke();
  }
}
