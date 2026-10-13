<template>
  <el-dialog v-model="visible" :title="t('userForward.title')" width="min(560px, calc(100% - 32px))" append-to-body destroy-on-close>
    <div class="forward-panel" v-loading="loading">
      <p class="mailbox">{{ source }}</p>
      <el-alert v-if="loaded && !data.configured" :title="t('userForward.notConfigured')" type="warning" :closable="false" show-icon />
      <el-alert v-if="failed || data.refreshFailed" :title="t('userForward.refreshFailed')" type="warning" :closable="false" show-icon />
      <el-alert v-if="notice" :title="t(notice)" :type="notice === 'userForward.requested' ? 'success' : 'info'" :closable="false" show-icon />
      <p>{{ t(readOnly ? 'userForward.cached' : 'userForward.help') }}</p>
      <el-button :disabled="loading || busy || (loaded && !data.configured)" @click="load(true)">{{ t('userForward.refresh') }}</el-button>
      <template v-if="loaded">
        <el-empty v-if="!data.list.length" :description="t('userForward.empty')" :image-size="64" />
        <ul v-else class="destinations">
          <li v-for="item in data.list" :key="item.forwardId">
            <div class="destination">
              <span v-if="readOnly" class="source">{{ item.source }}</span>
              <span>{{ item.email }}</span>
              <el-tag :type="item.verified ? 'success' : 'info'">{{ t(item.verified ? 'userForward.active' : 'userForward.pending') }}</el-tag>
            </div>
            <div v-if="!readOnly" class="actions">
              <el-button v-if="!item.verified" size="small" :disabled="busy || loading || !data.configured" @click="resend(item)">{{ t('userForward.resend') }}</el-button>
              <el-button size="small" type="danger" plain :disabled="busy || loading" @click="remove(item)">{{ t('delete') }}</el-button>
            </div>
          </li>
        </ul>
        <el-form v-if="!readOnly" @submit.prevent="add">
          <el-form-item :label="t('userForward.destination')">
            <el-input v-model="email" type="email" maxlength="90" :aria-label="t('userForward.destination')" :disabled="busy || loading || !data.configured || data.list.length >= data.limit" :placeholder="t('userForward.destination')" />
          </el-form-item>
          <div class="actions">
            <el-button native-type="submit" type="primary" :loading="busy" :disabled="loading || !data.configured || data.list.length >= data.limit || !email.trim()">{{ t('add') }}</el-button>
            <span>{{ t('userForward.limit', { count: data.list.length, limit: data.limit }) }}</span>
          </div>
        </el-form>
      </template>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { isEmail } from '@/utils/verify-utils.js';
import { forwardList, forwardAdd, forwardDelete, forwardResend, forwardRefresh, userForwardList } from '@/request/account.js';

const { t } = useI18n();
const visible = ref(false);
const loading = ref(false);
const busy = ref(false);
const loaded = ref(false);
const failed = ref(false);
const notice = ref('');
const readOnly = ref(false);
const source = ref('');
const email = ref('');
const data = ref({ configured: false, list: [], limit: 3 });
let id;
let generation = 0;

function open(item, admin = false) {
  generation++;
  id = admin ? item.userId : item.accountId;
  readOnly.value = admin;
  source.value = item.email;
  email.value = '';
  loaded.value = false;
  failed.value = false;
  notice.value = '';
  busy.value = false;
  data.value = { configured: false, list: [], limit: 3 };
  visible.value = true;
  load();
}

async function load(refresh = false) {
  const current = generation;
  loading.value = true;
  failed.value = false;
  try {
    const result = await (readOnly.value ? userForwardList(id) : refresh ? forwardRefresh(id) : forwardList(id));
    if (current !== generation) return;
    data.value = result;
    loaded.value = true;
  } catch {
    if (current === generation) failed.value = true;
  } finally {
    if (current === generation) loading.value = false;
  }
}

async function mutate(action, notify = false) {
  if (busy.value || loading.value) return;
  const current = generation;
  busy.value = true;
  try {
    const result = await action();
    if (current !== generation) return;
    if (notify) {
      notice.value = result.sent ? 'userForward.requested' : 'userForward.exists';
      email.value = '';
    }
    await load();
  } catch {
    // Request interceptor displays the server error; keep the current form for retry.
  } finally {
    if (current === generation) busy.value = false;
  }
}

function add() {
  const address = email.value.trim();
  if (!isEmail(address)) return ElMessage.error(t('notEmailMsg'));
  if (!data.value.configured || data.value.list.length >= data.value.limit) return;
  mutate(() => forwardAdd(id, address), true);
}

function resend(item) {
  mutate(() => forwardResend(id, item.forwardId), true);
}

async function remove(item) {
  const current = generation;
  try {
    await ElMessageBox.confirm(t('delConfirm', { msg: item.email }), {
      confirmButtonText: t('confirm'), cancelButtonText: t('cancel'), type: 'warning'
    });
    if (current === generation) await mutate(() => forwardDelete(id, item.forwardId));
  } catch {
    // Dismissed confirmation.
  }
}

defineExpose({ open });
</script>

<style scoped>
.forward-panel { display: grid; gap: 16px; }
.forward-panel p { margin: 0; }
.mailbox, .destination { overflow-wrap: anywhere; }
.destinations { list-style: none; padding: 0; margin: 0; }
.destinations li { padding: 12px 0; border-bottom: 1px solid var(--el-border-color); }
.destination { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.source { width: 100%; color: var(--el-text-color-regular); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.actions .el-button + .el-button { margin-left: 0; }
</style>
