import {
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { DshStandardScenarioRecord } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { PageFrame } from '../components/PageFrame.js';
import { ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { StatusTag } from '../components/StatusTag.js';
import { formatDateTime } from '../localization.js';

/**
 * DSH-01 standard-scenario catalogue.
 *
 * The Console is the *operator* view of the same rows the DSH client plugin installs. Two rules are
 * surfaced in the UI because they are not obvious from a form:
 *
 * - `version` and `revision` are never editable here. Every save, archive or attachment change
 *   advances them on the server, and the plugin upgrades itself by comparing them.
 * - deleting is a soft delete: the scenario becomes a tombstone the plugin uses to uninstall its
 *   local copy, so the row and its identity survive while the attachment bytes are released.
 */

type ScenarioForm = Readonly<{
  scenarioId: string;
  title: string;
  category: string;
  description: string;
  status: 'PUBLISHED' | 'ARCHIVED';
  payloadText: string;
}>;

const CATEGORY_FALLBACK = '通用场景';

export default function StandardScenariosPage() {
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();
  const [editingId, setEditingId] = useState<string | 'create' | null>(null);
  const [form] = Form.useForm<ScenarioForm>();
  const [uploading, setUploading] = useState(false);
  const query = useQuery({ queryKey: ['dsh-scenarios'], queryFn: () => adminApi.dshScenarios(true) });
  const scenarios = useMemo(() => query.data?.scenarios ?? [], [query.data]);
  const editing = editingId === 'create' || editingId === null
    ? null
    : scenarios.find((scenario) => scenario.scenarioId === editingId) ?? null;

  useEffect(() => {
    if (editingId !== 'create' && editingId !== null && query.data && !editing) {
      // The row disappeared (another operator deleted it) — close instead of editing a ghost.
      setEditingId(null);
    }
  }, [editing, editingId, query.data]);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['dsh-scenarios'] });
  };

  const save = useMutation({
    mutationFn: async (values: ScenarioForm) => {
      const scenarioPayload = parsePayload(values.payloadText);
      if (editingId === 'create') {
        return adminApi.createDshScenario({
          scenarioId: values.scenarioId.trim(),
          title: values.title.trim(),
          ...(values.category.trim() ? { category: values.category.trim() } : {}),
          description: values.description.trim(),
          scenarioPayload,
          status: values.status,
        });
      }
      if (!editing) throw new Error('未选择标准场景。');
      const currentPayload = JSON.stringify(editing.scenarioPayload ?? {}, null, 2);
      return adminApi.updateDshScenario(editing.scenarioId, {
        title: values.title.trim(),
        category: values.category.trim() || CATEGORY_FALLBACK,
        description: values.description.trim(),
        status: values.status,
        // Only send the payload when the operator actually changed it: every PUT is a new edition.
        ...(currentPayload === values.payloadText ? {} : { scenarioPayload }),
      });
    },
    onSuccess: async (result) => {
      await invalidate();
      setEditingId(null);
      form.resetFields();
      const { scenario } = 'scenario' in result ? result : { scenario: undefined };
      void message.success(
        scenario
          ? `标准场景已保存，版本升至 v${scenario.version}（Rev ${scenario.revision}）。`
          : '标准场景已保存。',
      );
    },
  });

  const toggleStatus = useMutation({
    mutationFn: (scenario: DshStandardScenarioRecord) => adminApi.updateDshScenario(scenario.scenarioId, {
      status: scenario.status === 'PUBLISHED' ? 'ARCHIVED' : 'PUBLISHED',
    }),
    onSuccess: async (result) => {
      await invalidate();
      void message.success(
        `已${result.scenario.status === 'PUBLISHED' ? '上架' : '下架'}，版本升至 v${result.scenario.version}（Rev ${result.scenario.revision}）。`,
      );
    },
  });

  const remove = useMutation({
    mutationFn: (scenario: DshStandardScenarioRecord) => adminApi.deleteDshScenario(scenario.scenarioId),
    onSuccess: async () => {
      await invalidate();
      void message.success('标准场景已软删除，插件端将在下次同步时清理本地已安装的副本。');
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!editing) throw new Error('请先保存标准场景，再上传预设附件。');
      return adminApi.uploadDshAttachment(editing.scenarioId, {
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64: await fileToBase64(file),
      });
    },
    onSuccess: async (result) => {
      await invalidate();
      void message.success(`已上传「${result.attachment.fileName}」，版本升至 v${result.scenario.version}（Rev ${result.scenario.revision}）。`);
    },
    onSettled: () => setUploading(false),
  });

  const removeAttachment = useMutation({
    mutationFn: (attachmentId: string) => {
      if (!editing) return Promise.reject(new Error('未选择标准场景。'));
      return adminApi.deleteDshAttachment(editing.scenarioId, attachmentId);
    },
    onSuccess: async (result) => {
      await invalidate();
      void message.success(`已删除预设附件，版本升至 v${result.scenario.version}（Rev ${result.scenario.revision}）。`);
    },
  });

  const mutationError = save.error ?? toggleStatus.error ?? remove.error ?? upload.error ?? removeAttachment.error;

  const openCreate = (): void => {
    form.setFieldsValue({
      scenarioId: '',
      title: '',
      category: CATEGORY_FALLBACK,
      description: '',
      status: 'PUBLISHED',
      payloadText: defaultPayloadText(),
    });
    setEditingId('create');
  };

  const openEdit = (scenario: DshStandardScenarioRecord): void => {
    form.setFieldsValue({
      scenarioId: scenario.scenarioId,
      title: scenario.title,
      category: scenario.category,
      description: scenario.description,
      status: scenario.status === 'ARCHIVED' ? 'ARCHIVED' : 'PUBLISHED',
      payloadText: JSON.stringify(scenario.scenarioPayload ?? {}, null, 2),
    });
    setEditingId(scenario.scenarioId);
  };

  const confirmDelete = (scenario: DshStandardScenarioRecord): void => {
    modal.confirm({
      title: '删除标准场景？',
      content: (
        <Space orientation="vertical" size="small" className="full-width">
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="场景">{scenario.title}</Descriptions.Item>
            <Descriptions.Item label="场景 ID"><code>{scenario.scenarioId}</code></Descriptions.Item>
            <Descriptions.Item label="当前版本">v{scenario.version}（Rev {scenario.revision}）</Descriptions.Item>
          </Descriptions>
          <ul className="guidance-list">
            <li>场景将变为已删除状态，插件端下次同步时会移除本地已安装的副本。</li>
            <li>随场景上传的预设附件二进制将被立即删除以释放空间。</li>
            <li>该场景 ID 之后仍可用于重新发布同名的标准场景。</li>
          </ul>
          <Typography.Text type="danger" strong>此操作会立即影响全部已安装该场景的用户。</Typography.Text>
        </Space>
      ),
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => remove.mutateAsync(scenario),
    });
  };

  return (
    <PageFrame
      title="标准场景管理"
      description="维护 DSH 插件可分发的标准场景：普通用户安装后只读，每次编辑由服务端自动升版并推送给插件端。"
      action={
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建标准场景</Button>
          <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>刷新</Button>
        </Space>
      }
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <MutationError error={mutationError} />
        <Alert
          type="info"
          showIcon
          title="版本由服务端自动维护"
          description="编辑场景内容、切换上架状态或增删预设附件，都会自动将 revision +1 并把 version 的补丁位 +1（例如 1.0.2 → 1.0.3）。插件端通过比对 revision / version 决定是否自动覆盖升级。"
        />

        {query.isPending ? <LoadingState rows={4} /> : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : scenarios.length === 0 ? (
          <div className="surface-card">
            <Empty description="尚未发布任何标准场景。">
              <Button type="primary" onClick={openCreate}>创建第一个标准场景</Button>
            </Empty>
          </div>
        ) : (
          <div className="scenario-grid">
            {scenarios.map((scenario) => (
              <ScenarioCard
                key={scenario.scenarioId}
                scenario={scenario}
                busy={toggleStatus.isPending || remove.isPending}
                onEdit={() => openEdit(scenario)}
                onToggle={() => toggleStatus.mutate(scenario)}
                onDelete={() => confirmDelete(scenario)}
              />
            ))}
          </div>
        )}
      </Space>

      <Modal
        open={editingId !== null}
        title={editingId === 'create' ? '新建标准场景' : `编辑标准场景 · ${editing?.scenarioId ?? ''}`}
        okText="保存（自动升版）"
        confirmLoading={save.isPending}
        width={760}
        onCancel={() => { setEditingId(null); save.reset(); }}
        onOk={() => void form.submit()}
        destroyOnHidden
      >
        <Form<ScenarioForm> form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Form.Item
            name="scenarioId"
            label="场景 ID"
            extra="插件端的唯一标识（scenarioId），保存后不可修改；仅允许字母、数字、点、下划线与连字符。"
            rules={[
              { required: true, whitespace: true, message: '请输入场景 ID。' },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, message: '仅允许字母、数字、点、下划线与连字符，且以字母或数字开头。' },
              { pattern: /^(?!permission$)/u, message: 'permission 为保留标识。' },
            ]}
          >
            <Input autoComplete="off" disabled={editingId !== 'create'} />
          </Form.Item>
          <Form.Item name="title" label="场景标题" rules={[{ required: true, whitespace: true, message: '请输入场景标题。' }, { max: 128 }]}>
            <Input autoComplete="off" showCount maxLength={128} />
          </Form.Item>
          <Form.Item name="category" label="分类标签" rules={[{ max: 64 }]}>
            <Input autoComplete="off" showCount maxLength={64} placeholder={CATEGORY_FALLBACK} />
          </Form.Item>
          <Form.Item name="description" label="场景介绍" rules={[{ required: true, whitespace: true, message: '请输入场景介绍。' }, { max: 4_000 }]}>
            <Input.TextArea rows={3} showCount maxLength={4_000} placeholder="说明场景的功能与适用范围。" />
          </Form.Item>
          <Form.Item name="status" label="上架状态" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'PUBLISHED', label: '已上架（插件可见）' },
                { value: 'ARCHIVED', label: '已下架（插件不可见，保留配置）' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="payloadText"
            label="场景配置 Payload（JSON）"
            extra="保存时服务端会强制写入 sourceType=COMPANY_STANDARD 与 readonlyForNormalUser=true，普通用户无法直接修改标准场景。"
            rules={[{
              validator: async (_rule, value: string) => {
                try {
                  parsePayload(value);
                } catch (error) {
                  throw new Error(error instanceof Error ? error.message : 'JSON 无效。');
                }
              },
            }]}
          >
            <Input.TextArea rows={10} className="scenario-payload-input" spellCheck={false} />
          </Form.Item>
        </Form>

        {editingId === 'create' ? (
          <Alert type="info" showIcon title="保存后可在编辑弹窗中上传预设附件。" />
        ) : (
          <>
            <Divider titlePlacement="start">预设附件</Divider>
            <Space orientation="vertical" size="small" className="full-width">
              {editing?.presetAttachments.length ? editing.presetAttachments.map((attachment) => (
                <div key={attachment.attachmentId} className="scenario-attachment-row">
                  <Space size={6} wrap>
                    <Typography.Text strong>{attachment.fileName}</Typography.Text>
                    <Tag>{formatBytes(attachment.fileSize)}</Tag>
                    <Typography.Text type="secondary" copyable={{ text: attachment.sha256 }}>
                      {attachment.sha256.slice(0, 12)}…
                    </Typography.Text>
                  </Space>
                  <Space size={4}>
                    <Tooltip title="下载附件">
                      <Button
                        type="text"
                        aria-label={`下载 ${attachment.fileName}`}
                        icon={<DownloadOutlined />}
                        href={adminApi.dshAttachmentUrl(editing.scenarioId, attachment.attachmentId)}
                        target="_blank"
                        rel="noreferrer"
                      />
                    </Tooltip>
                    <Popconfirm
                      title="删除该预设附件？"
                      description="删除后主场景版本会自动 +1，已安装该场景的用户将重新拉取。"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => removeAttachment.mutate(attachment.attachmentId)}
                    >
                      <Button type="text" danger aria-label={`删除 ${attachment.fileName}`} icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </div>
              )) : <Typography.Text type="secondary">尚未上传预设附件。</Typography.Text>}
              <Upload
                showUploadList={false}
                beforeUpload={(file) => {
                  setUploading(true);
                  upload.mutate(file as File);
                  return false;
                }}
                disabled={uploading}
              >
                <Button icon={<CloudUploadOutlined />} loading={uploading}>上传预设附件</Button>
              </Upload>
              <Typography.Text type="secondary">
                附件会随标准场景分发，安装该场景的用户首次打开会话时自动带入。单个附件上限由服务端配置决定。
              </Typography.Text>
            </Space>
          </>
        )}
      </Modal>
    </PageFrame>
  );
}

function ScenarioCard({
  scenario,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: Readonly<{
  scenario: DshStandardScenarioRecord;
  busy: boolean;
  onEdit(): void;
  onToggle(): void;
  onDelete(): void;
}>) {
  const pinnedSkills = readPinnedSkills(scenario.scenarioPayload);
  return (
    <article className="surface-card scenario-card" aria-label={`标准场景 ${scenario.title}`}>
      <div className="scenario-card-head">
        <div>
          <Typography.Title level={4}>{scenario.title}</Typography.Title>
          <Space size={6} wrap>
            <code>{scenario.scenarioId}</code>
            <Tag>{scenario.category}</Tag>
            <StatusTag label={scenario.status} />
          </Space>
        </div>
        <Tag color="blue">v{scenario.version}（Rev {scenario.revision}）</Tag>
      </div>
      <Typography.Paragraph type="secondary" className="scenario-description">{scenario.description}</Typography.Paragraph>
      <div className="scenario-section">
        <Typography.Text type="secondary">绑定 Skill</Typography.Text>
        <Space size={4} wrap>
          {pinnedSkills.length
            ? pinnedSkills.map((skill) => <Tag key={skill} color="geekblue">{skill}</Tag>)
            : <Typography.Text type="secondary">未绑定</Typography.Text>}
        </Space>
      </div>
      <div className="scenario-section">
        <Typography.Text type="secondary">预设附件（{scenario.presetAttachments.length}）</Typography.Text>
        <Space size={4} wrap>
          {scenario.presetAttachments.length
            ? scenario.presetAttachments.map((attachment) => (
                <Tooltip key={attachment.attachmentId} title={`${attachment.fileName} · ${formatBytes(attachment.fileSize)}`}>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    href={adminApi.dshAttachmentUrl(scenario.scenarioId, attachment.attachmentId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {attachment.fileName}
                  </Button>
                </Tooltip>
              ))
            : <Typography.Text type="secondary">无</Typography.Text>}
        </Space>
      </div>
      <Descriptions size="small" column={1} className="scenario-meta">
        <Descriptions.Item label="发布人">
          <code>{scenario.createdByPlatformUid}</code>
          {scenario.createdByCrmUser ? ` · ${scenario.createdByCrmUser}` : ''}
        </Descriptions.Item>
        <Descriptions.Item label="最后更新">{formatDateTime(scenario.updatedAt)}（{scenario.updatedByPlatformUid}）</Descriptions.Item>
      </Descriptions>
      <Space size="small" wrap>
        <Button type="primary" ghost icon={<EditOutlined />} aria-label={`编辑 ${scenario.title}`} onClick={onEdit}>编辑</Button>
        <Button
          icon={scenario.status === 'PUBLISHED' ? <EyeInvisibleOutlined /> : <EyeOutlined />}
          aria-label={`${scenario.status === 'PUBLISHED' ? '下架' : '上架'} ${scenario.title}`}
          loading={busy}
          onClick={onToggle}
        >
          {scenario.status === 'PUBLISHED' ? '下架' : '上架'}
        </Button>
        <Button danger icon={<DeleteOutlined />} aria-label={`删除 ${scenario.title}`} onClick={onDelete}>删除</Button>
      </Space>
    </article>
  );
}

function parsePayload(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('场景配置必须是合法的 JSON。');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('场景配置必须是一个 JSON 对象。');
  }
  return parsed;
}

function defaultPayloadText(): string {
  return JSON.stringify({ pinnedSkills: [], welcomeMessage: '', inputDraft: '', prePinnedContext: {} }, null, 2);
}

function readPinnedSkills(payload: unknown): readonly string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const value = (payload as Record<string, unknown>).pinnedSkills;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 8_192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
