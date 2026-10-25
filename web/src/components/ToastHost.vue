<script setup lang="ts">
import { toasts } from '../lib/toast';
</script>

<template>
  <div class="toast-wrap" aria-live="polite" aria-atomic="false">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="{ bad: t.bad }">{{ t.text }}</div>
  </div>
</template>
