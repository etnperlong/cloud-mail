<template>
  <button
    type="button"
    class="icon-btn"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
    @click="onClick"
  >
    <slot />
  </button>
</template>

<script setup>
defineOptions({ name: 'IconButton' });
defineProps({
  label: { type: String, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['click']);
function onClick(e) {
  emit('click', e);
}
</script>

<style scoped>
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  line-height: 0;
  vertical-align: middle;
}
.icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>