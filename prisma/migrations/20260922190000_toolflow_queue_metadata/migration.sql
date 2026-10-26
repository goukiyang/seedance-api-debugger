ALTER TABLE "ImageStudioTask" ADD COLUMN "tool_flow_run_id" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "tool_flow_node_id" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "tool_flow_version" INTEGER;
ALTER TABLE "ImageStudioTask" ADD COLUMN "tool_flow_item_index" INTEGER;
CREATE INDEX "ImageStudioTask_tool_flow_run_id_tool_flow_node_id_status_idx" ON "ImageStudioTask"("tool_flow_run_id", "tool_flow_node_id", "status");

ALTER TABLE "Asset" ADD COLUMN "metadata_json" TEXT;
