-- Template-driven Agent workbench
ALTER TABLE "VideoTask" ADD COLUMN "template_id" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "agent_run_id" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "selected_agent_plan_key" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "agent_prompt_snapshot" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "final_prompt_snapshot" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "prompt_user_edited" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "GenerationTemplate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "template_key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "version" TEXT NOT NULL DEFAULT 'v1',
  "module_bindings_json" TEXT NOT NULL DEFAULT '{}',
  "temporal_json" TEXT NOT NULL DEFAULT '{"enabled":true,"segment":15,"handoff":false}',
  "default_ratio" TEXT,
  "default_duration" INTEGER,
  "default_resolution" TEXT,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "TemplateAsset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "template_id" TEXT NOT NULL,
  "asset_type" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "url" TEXT,
  "thumbnail_url" TEXT,
  "reference_image_id" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata_json" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TemplateAsset_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "GenerationTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TemplateRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "template_id" TEXT NOT NULL,
  "rule_type" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 50,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TemplateRule_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "GenerationTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TemplatePromptBlock" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "template_id" TEXT NOT NULL,
  "block_type" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TemplatePromptBlock_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "GenerationTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "template_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "video_task_id" TEXT,
  "video_card_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "user_input_json" TEXT NOT NULL,
  "modifiers_json" TEXT NOT NULL DEFAULT '[]',
  "plans_json" TEXT NOT NULL DEFAULT '[]',
  "selected_plan_key" TEXT,
  "agent_prompt_snapshot" TEXT,
  "final_prompt_snapshot" TEXT,
  "user_edited" BOOLEAN NOT NULL DEFAULT false,
  "error_message" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" DATETIME,
  CONSTRAINT "AgentRun_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "GenerationTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AgentRunStep" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agent_run_id" TEXT NOT NULL,
  "step_key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "input_json" TEXT,
  "output_json" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentRunStep_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TemplateMemory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "template_id" TEXT NOT NULL,
  "user_id" TEXT,
  "agent_run_id" TEXT,
  "video_task_id" TEXT,
  "memory_type" TEXT NOT NULL,
  "signal" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "metadata_json" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TemplateMemory_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "GenerationTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "GenerationTemplate_template_key_key" ON "GenerationTemplate"("template_key");
CREATE INDEX "GenerationTemplate_status_idx" ON "GenerationTemplate"("status");
CREATE INDEX "GenerationTemplate_created_by_idx" ON "GenerationTemplate"("created_by");
CREATE INDEX "GenerationTemplate_updated_at_idx" ON "GenerationTemplate"("updated_at");

CREATE INDEX "TemplateAsset_template_id_idx" ON "TemplateAsset"("template_id");
CREATE INDEX "TemplateAsset_asset_type_idx" ON "TemplateAsset"("asset_type");
CREATE INDEX "TemplateAsset_status_idx" ON "TemplateAsset"("status");

CREATE INDEX "TemplateRule_template_id_idx" ON "TemplateRule"("template_id");
CREATE INDEX "TemplateRule_rule_type_idx" ON "TemplateRule"("rule_type");
CREATE INDEX "TemplateRule_status_idx" ON "TemplateRule"("status");

CREATE INDEX "TemplatePromptBlock_template_id_idx" ON "TemplatePromptBlock"("template_id");
CREATE INDEX "TemplatePromptBlock_block_type_idx" ON "TemplatePromptBlock"("block_type");
CREATE INDEX "TemplatePromptBlock_status_idx" ON "TemplatePromptBlock"("status");

CREATE INDEX "AgentRun_template_id_idx" ON "AgentRun"("template_id");
CREATE INDEX "AgentRun_user_id_idx" ON "AgentRun"("user_id");
CREATE INDEX "AgentRun_video_task_id_idx" ON "AgentRun"("video_task_id");
CREATE INDEX "AgentRun_video_card_id_idx" ON "AgentRun"("video_card_id");
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");
CREATE INDEX "AgentRun_created_at_idx" ON "AgentRun"("created_at");

CREATE INDEX "AgentRunStep_agent_run_id_idx" ON "AgentRunStep"("agent_run_id");
CREATE INDEX "AgentRunStep_step_key_idx" ON "AgentRunStep"("step_key");
CREATE INDEX "AgentRunStep_sort_order_idx" ON "AgentRunStep"("sort_order");

CREATE INDEX "TemplateMemory_template_id_idx" ON "TemplateMemory"("template_id");
CREATE INDEX "TemplateMemory_user_id_idx" ON "TemplateMemory"("user_id");
CREATE INDEX "TemplateMemory_agent_run_id_idx" ON "TemplateMemory"("agent_run_id");
CREATE INDEX "TemplateMemory_video_task_id_idx" ON "TemplateMemory"("video_task_id");
CREATE INDEX "TemplateMemory_memory_type_idx" ON "TemplateMemory"("memory_type");
CREATE INDEX "TemplateMemory_created_at_idx" ON "TemplateMemory"("created_at");

CREATE INDEX "VideoTask_template_id_idx" ON "VideoTask"("template_id");
CREATE INDEX "VideoTask_agent_run_id_idx" ON "VideoTask"("agent_run_id");

INSERT INTO "GenerationTemplate" (
  "id",
  "template_key",
  "name",
  "description",
  "status",
  "version",
  "module_bindings_json",
  "temporal_json",
  "default_ratio",
  "default_duration",
  "default_resolution",
  "created_by"
) VALUES (
  'tpl_seedance_brand_video_v1',
  'brand_video_v1',
  '品牌宣传视频',
  '用于科技品牌、产品发布和品牌统一表达的 Seedance 2.0 默认模板。',
  'active',
  'v1',
  '{"character":"brand_ip","logo":"brand_logo","style":"tech_brand","camera":"fast_motion"}',
  '{"enabled":true,"segment":15,"handoff":false}',
  '16:9',
  5,
  '720p',
  'system'
);

INSERT INTO "TemplateRule" ("id", "template_id", "rule_type", "content", "priority", "sort_order") VALUES
  ('tr_seedance_brand_must_1', 'tpl_seedance_brand_video_v1', 'must', '保持品牌 Logo 清晰稳定，不能变形、漂移或被遮挡。', 95, 1),
  ('tr_seedance_brand_must_2', 'tpl_seedance_brand_video_v1', 'must', '角色或品牌 IP 在多镜头中保持身份、配色和比例一致。', 90, 2),
  ('tr_seedance_brand_forbid_1', 'tpl_seedance_brand_video_v1', 'forbid', '禁止出现与品牌调性冲突的廉价促销、夸张噪声和无关元素。', 90, 1),
  ('tr_seedance_brand_suggest_1', 'tpl_seedance_brand_video_v1', 'suggest', '优先使用干净的产品动线、明确的转场和可识别的品牌色。', 70, 1);

INSERT INTO "TemplatePromptBlock" ("id", "template_id", "block_type", "content", "sort_order") VALUES
  ('tp_seedance_brand_character', 'tpl_seedance_brand_video_v1', 'character', '保持品牌角色或 IP 的外观、材质、色彩和身份一致。', 1),
  ('tp_seedance_brand_logo', 'tpl_seedance_brand_video_v1', 'logo', 'Logo 应作为清晰品牌信号出现，稳定、可读、不过度变形。', 2),
  ('tp_seedance_brand_style', 'tpl_seedance_brand_video_v1', 'style', '整体风格为克制的科技品牌视觉，画面干净、节奏明确、质感真实。', 3),
  ('tp_seedance_brand_global', 'tpl_seedance_brand_video_v1', 'global', '输出适合 Seedance 2.0 的连续视频提示词，强调镜头、动作、主体一致性和品牌稳定性。', 4);

INSERT INTO "TemplateAsset" ("id", "template_id", "asset_type", "label", "metadata_json", "sort_order") VALUES
  ('ta_seedance_brand_character', 'tpl_seedance_brand_video_v1', 'character', '品牌角色参考', '{"placeholder":true}', 1),
  ('ta_seedance_brand_logo', 'tpl_seedance_brand_video_v1', 'logo', '品牌 Logo 参考', '{"placeholder":true}', 2),
  ('ta_seedance_brand_style', 'tpl_seedance_brand_video_v1', 'style', '科技风格参考', '{"placeholder":true}', 3);
