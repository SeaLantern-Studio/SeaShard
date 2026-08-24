import { agentWorkspace } from "@seashard/agent-ui-shared";
import {
  agentInvocationContract,
  agentModelConfigurationContract,
  agentSessionContract,
  type AgentInvocationService,
  type AgentModelConfigurationClientService,
  type AgentSessionService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { defineComponent, h } from "vue";
import AgentConversationPage from "./AgentConversationPage.vue";
import AgentWorkspaceSidebar from "./AgentWorkspaceSidebar.vue";

export default defineClientUiModule({
  apply(context) {
    const sessions = context.service<AgentSessionService>(agentSessionContract);
    const invocations = context.service<AgentInvocationService>(agentInvocationContract);
    const modelConfiguration = context.service<AgentModelConfigurationClientService>(
      agentModelConfigurationContract,
    );
    context.effect(() => agentWorkspace.bind(sessions), "Agent workspace session binding");

    const page = defineComponent({
      name: "AgentConversationFeaturePage",
      setup: () => () =>
        h(AgentConversationPage, {
          sessions,
          invocations,
          modelConfiguration,
          workspace: agentWorkspace,
        }),
    });
    context.contribute("navigation.page", {
      id: "agent-conversation",
      path: "/agent/chat",
      label: "对话",
      order: -100,
      navigation: false,
      placement: "main",
      component: page,
    });
    context.contribute("workspace.sidebar", {
      id: "agent-conversation-sidebar",
      workspaceId: "agent",
      component: AgentWorkspaceSidebar,
    });
  },
});
