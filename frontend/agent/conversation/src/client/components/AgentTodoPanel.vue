<script setup lang="ts">
import type { AgentTodoSnapshot } from "@seashard/contracts";
import { CheckCircle2, ChevronDown, Circle, CircleDot, ListTodo } from "lucide-vue-next";
import { computed, ref } from "vue";
import "./AgentTodoPanel.css";

const props = defineProps<{
  todo: AgentTodoSnapshot;
}>();

const expanded = ref(true);
const completedCount = computed(
  () => props.todo.items.filter(({ status }) => status === "completed").length,
);
const currentItem = computed(
  () =>
    props.todo.items.find(({ status }) => status === "in_progress") ??
    props.todo.items.find(({ status }) => status === "pending"),
);
const collapsedCurrentLabel = computed(() => currentItem.value?.content ?? "全部完成");
</script>

<template>
  <section class="agent-todo-panel" :class="{ 'is-collapsed': !expanded }" aria-label="TODO">
    <button
      type="button"
      class="agent-todo-toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <ListTodo :size="17" :stroke-width="1.9" aria-hidden="true" />
      <strong v-if="expanded">TODO</strong>
      <span class="agent-todo-progress">{{ completedCount }}/{{ todo.items.length }}</span>
      <span v-if="!expanded" class="agent-todo-current">{{ collapsedCurrentLabel }}</span>
      <ChevronDown
        class="agent-todo-chevron"
        :class="{ 'is-expanded': expanded }"
        :size="16"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>

    <Transition name="agent-todo-list">
      <ol v-if="expanded" class="agent-todo-list">
        <li
          v-for="(item, index) in todo.items"
          :key="`${index}:${item.content}`"
          class="agent-todo-item"
          :class="`is-${item.status}`"
        >
          <CheckCircle2
            v-if="item.status === 'completed'"
            :size="16"
            :stroke-width="1.9"
            aria-hidden="true"
          />
          <CircleDot
            v-else-if="item.status === 'in_progress'"
            :size="16"
            :stroke-width="1.9"
            aria-hidden="true"
          />
          <Circle v-else :size="16" :stroke-width="1.7" aria-hidden="true" />
          <span>{{ item.content }}</span>
        </li>
      </ol>
    </Transition>
  </section>
</template>
