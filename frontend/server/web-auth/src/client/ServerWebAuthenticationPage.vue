<script setup lang="ts">
import { Cmz_Button } from "cmzya-modern-ui";
import { LockKeyhole, UserRound } from "lucide-vue-next";
import { ref } from "vue";
import logoSvg from "@seashard/application-shell/logo.svg";

const props = withDefaults(
  defineProps<{
    setupRequired: boolean;
    busy?: boolean;
  }>(),
  { busy: false },
);
const emit = defineEmits<{
  submit: [credentials: { username: string; password: string }];
}>();
const username = ref("admin");
const password = ref("");

function submit(): void {
  if (props.busy || !username.value.trim() || !password.value) return;
  emit("submit", { username: username.value.trim(), password: password.value });
}
</script>

<template>
  <main class="server-auth-page">
    <div class="app-background"></div>
    <form class="server-auth-panel" @submit.prevent="submit">
      <div class="server-auth-brand">
        <img :src="logoSvg" width="32" height="32" alt="" draggable="false" />
        <span>SeaShard</span>
      </div>
      <h1>{{ props.setupRequired ? "设置管理员" : "登录 SeaShard" }}</h1>

      <label class="server-auth-field">
        <span>用户名</span>
        <span class="server-auth-input">
          <UserRound :size="17" :stroke-width="1.8" />
          <input
            v-model="username"
            name="username"
            autocomplete="username"
            required
            :disabled="props.busy"
          />
        </span>
      </label>

      <label class="server-auth-field">
        <span>密码</span>
        <span class="server-auth-input">
          <LockKeyhole :size="17" :stroke-width="1.8" />
          <input
            v-model="password"
            name="password"
            type="password"
            :autocomplete="props.setupRequired ? 'new-password' : 'current-password'"
            minlength="12"
            maxlength="128"
            required
            :disabled="props.busy"
          />
        </span>
      </label>

      <Cmz_Button type="submit" :loading="props.busy" :disabled="props.busy">
        {{ props.setupRequired ? "完成设置" : "登录" }}
      </Cmz_Button>
    </form>
  </main>
</template>

<style scoped src="./ServerWebAuthenticationPage.css"></style>
