'use client';

import { useId } from 'react';
import { ImagePlus, X } from 'lucide-react';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import type { SharedStudioFixedReferenceRepair, SharedStudioRepairDefinition, SharedStudioRepairReference } from '@/lib/image-studio/shared-types';
import { StudioReferenceGrid, type FixedStudioReference } from './reference-grid';
import type { StudioStyleSummary } from './style-groups-view';
import type { SkillSummary } from './skills-view';
import styles from './studio.module.css';

export type StudioRepairFieldsProps = {
  repair: SharedStudioRepairDefinition;
  templatePrompt: string;
  onTemplatePrompt: (value: string) => void;
  templateImages: UploadedAssetPayload[];
  onTemplateImages: (next: UploadedAssetPayload[]) => void;
  fixedReferences: FixedStudioReference[];
  onFixedReferences: (next: FixedStudioReference[]) => void;
  styleGroups: StudioStyleSummary[];
  onStyleGroups: (next: StudioStyleSummary[]) => void;
  skills: SkillSummary[];
  onSkills: (next: SkillSummary[]) => void;
  banner: UploadedAssetPayload | null;
  onBanner: (next: UploadedAssetPayload | null) => void;
  fixedEditable: boolean;
  fixedRepairs: SharedStudioFixedReferenceRepair[];
  onRepairFixed: (sourceIndex: number, replacementAssetId: string | null | undefined) => void;
  onReplaceFixed: (sourceIndex: number) => void;
  disabled: boolean;
  onAddTemplate: () => void;
  onReplaceBanner: () => void;
  onPreview: (image: UploadedAssetPayload, number: number) => void;
};

// The repair DTO supplies the permission-safe status. Never preview old media
// just because a previous local selection still has a URL.
function displayReference(item: UploadedAssetPayload, source?: SharedStudioRepairReference): UploadedAssetPayload {
  if (source && source.status !== 'valid') return { id: item.id };
  return item.originalUrl ? item : source?.image ? { ...source.image } : { id: item.id };
}

function restoreSelection<T extends UploadedAssetPayload>(next: UploadedAssetPayload[], current: T[]): T[] {
  // Grid removal/reordering must not write the redacted display objects back.
  return next.flatMap(item => {
    const original = current.find(candidate => candidate === item || candidate.id === item.id);
    return original ? [original] : [];
  });
}

export function StudioRepairFields({ repair, templatePrompt, onTemplatePrompt, templateImages, onTemplateImages,
  fixedReferences, onFixedReferences, styleGroups, onStyleGroups, skills, onSkills, banner, onBanner,
  fixedEditable, fixedRepairs, onRepairFixed, onReplaceFixed, disabled, onAddTemplate, onReplaceBanner, onPreview }: StudioRepairFieldsProps): JSX.Element {
  const promptId = useId();
  const canEditFixed = fixedEditable && repair.fixedReferencesEditable !== false;
  const selectedRestrictedSkills = Boolean(repair.skillRestriction && skills.some(item => repair.skillIds.includes(item.id)));
  const templateSource = (id?: string) => repair.templateReferences.find(item => item.id === id);
  const fixedSource = (id?: string) => repair.fixedReferences.find(item => item.id === id);
  const templateDisplay = templateImages.map(item => displayReference(item, templateSource(item.id)));
  const fixedDisplay = fixedReferences.map((item, index) => {
    const source = canEditFixed ? fixedSource(item.id) : repair.fixedReferences[index];
    // A valid but intentionally protected fixed slot must not reuse old local
    // media URLs or notes as an implicit new author read permission.
    return source && !source.image ? { id: item.id } : displayReference(item, source);
  });
  const bannerSource = banner && repair.banner && repair.banner.id === banner.id ? repair.banner : undefined;
  const bannerDisplay = banner ? displayReference(banner, bannerSource) : null;
  const pending = (source: SharedStudioRepairReference | undefined, image: UploadedAssetPayload) =>
    source?.status === 'missing' ? '原图已不可用' : source?.status === 'inaccessible' ? '当前无权读取原图'
      : !image.originalUrl ? '原图暂不可读取' : null;

  return <>
    <section className={styles.materialSection} aria-label="模板文字修复">
      <label className={styles.label} htmlFor={promptId}>模板提示词</label>
      <textarea id={promptId} rows={5} value={templatePrompt} disabled={disabled}
        onChange={event => onTemplatePrompt(event.target.value)} />
      <p className={styles.muted}>这里修改模板定义，保存成功后才会生效。</p>
    </section>

    <section className={styles.materialSection} aria-label="模板参考图修复">
      <div className={styles.materialHeading}><h3>模板参考图</h3><span>{templateImages.length} 张</span></div>
      <StudioReferenceGrid items={templateDisplay} compact materialTiles labels="template" disabled={disabled}
        onChange={next => { if (!disabled) onTemplateImages(restoreSelection(next, templateImages)); }} onPreview={onPreview}
        renderDetails={(image, index) => {
          const source = templateSource(image.id);
          const issue = pending(source, image);
          const sourceIndex = repair.templateReferences.findIndex(item => item.id === image.id);
          return issue ? <p className={styles.muted} role="status">模板参考 {sourceIndex >= 0 ? sourceIndex + 1 : index + 1} 待处理：{issue}。可移除后选择替换。</p> : null;
        }}>
        <button type="button" className={styles.add} disabled={disabled} onClick={onAddTemplate}>
          <ImagePlus size={20} />选择替换或添加
        </button>
      </StudioReferenceGrid>
    </section>

    <section className={styles.materialSection} aria-label="固定参考图修复">
      <div className={styles.materialHeading}><h3>固定参考图</h3><span>{fixedReferences.length} 张</span></div>
      {repair.fixedReferenceRestriction ? <p className={styles.muted}>{repair.fixedReferenceRestriction}</p>
        : !canEditFixed && <p className={styles.muted}>固定参考需管理员修复，未改项仍保留。</p>}
      <StudioReferenceGrid items={fixedDisplay} compact materialTiles labels="template" disabled={disabled || !canEditFixed}
        unavailableLabel={(image, index) => (canEditFixed ? fixedSource(image.id) : repair.fixedReferences[index])?.status === 'valid' ? '正常参考 · 受保护' : '失效参考'}
        onChange={next => { if (!disabled && canEditFixed) onFixedReferences(restoreSelection(next, fixedReferences)); }} onPreview={onPreview}
        renderDetails={(image, index) => {
          const source = canEditFixed ? fixedSource(image.id) : repair.fixedReferences[index];
          const issue = pending(source, image);
          const sourceIndex = source?.sourceIndex ?? repair.fixedReferences.findIndex(item => item.id === image.id);
          const number = sourceIndex >= 0 ? sourceIndex + 1 : index + 1;
          const repairIndex = source?.sourceIndex ?? sourceIndex;
          const canRepair = !canEditFixed && repair.fixedReferenceRepairAllowed === true && source?.repairable === true;
          const proposed = fixedRepairs.find(item => item.sourceIndex === repairIndex && item.originalAssetId === source?.id);
          const protectedNote = Boolean(source && source.status !== 'valid');
          const note = protectedNote ? source?.note || '' : fixedReferences[index].note;
          return <div className={styles.referenceNote}>
            {source?.status === 'valid' && !source.image && <p className={styles.muted}>正常固定参考，原图和备注保持原权限。</p>}
            {source?.status !== 'valid' && issue && <p className={styles.muted} role="status">固定参考 {number} 待处理：{issue}。{canEditFixed || canRepair ? '可移除或替换失效引用。' : '请联系具有原权限的管理员修复。'}</p>}
            {canRepair && <div className={styles.materialFooter}>
              <span role="status">{proposed ? proposed.replacementAssetId === null ? '已移除，待保存' : '替换图已选择，待保存' : '未修改'}</span>
              <button type="button" disabled={disabled} onClick={() => onRepairFixed(repairIndex, null)}>移除失效项</button>
              <button type="button" disabled={disabled} onClick={() => onReplaceFixed(repairIndex)}>选择替换图</button>
              {proposed && <button type="button" disabled={disabled} onClick={() => onRepairFixed(repairIndex, undefined)}>撤销修改</button>}
            </div>}
            {canEditFixed && !protectedNote ? <textarea aria-label={`固定参考 ${number} 备注`} rows={2} maxLength={2000}
              disabled={disabled} value={note} onChange={event => {
                if (!disabled) onFixedReferences(fixedReferences.map((item, position) => position === index ? { ...item, note: event.target.value } : item));
              }} /> : note && <p className={styles.muted}>{note}</p>}
          </div>;
        }} />
    </section>

    <section className={styles.materialSection} aria-label="风格与提示词组修复">
      <div className={styles.materialHeading}><h3>风格与提示词组</h3></div>
      {selectedRestrictedSkills && <p className={styles.muted} role="status">{repair.skillRestriction}</p>}
      {styleGroups.map((group, index) => {
        const sourceIndex = repair.styleGroups.findIndex(item => item.id === group.id);
        const source = repair.styleGroups[sourceIndex];
        const unavailable = source ? source.status !== 'valid' : Boolean(group.unavailable);
        const label = unavailable ? source?.name || `风格组 ${sourceIndex >= 0 ? sourceIndex + 1 : index + 1}` : group.name;
        return <div key={`style-${group.id}`} className={styles.materialFooter}>
          <span>{label}{unavailable ? ' · 待处理，当前不可使用' : ''}</span>
          <button type="button" disabled={disabled} aria-label={`移除${label}`} onClick={() => {
            if (!disabled) onStyleGroups(styleGroups.filter((_, position) => position !== index));
          }}><X size={14} />移除当前选择</button>
        </div>;
      })}
      {skills.map((skill, index) => {
        const sourceIndex = repair.skillGroups.findIndex(item => item.id === skill.id);
        const source = repair.skillGroups[sourceIndex];
        const unavailable = source ? source.status !== 'valid' : Boolean(skill.unavailable);
        const needsRemoval = Boolean(repair.skillRestriction && repair.skillIds.includes(skill.id));
        const label = unavailable ? source?.name || `提示词组 ${sourceIndex >= 0 ? sourceIndex + 1 : index + 1}` : skill.name;
        return <div key={`skill-${skill.id}`} className={styles.materialFooter}>
          <span>{label}{unavailable ? ' · 待处理，当前不可使用' : ''}{needsRemoval ? ' · 保存前需移除' : ''}</span>
          <button type="button" disabled={disabled} aria-label={`移除${label}`} onClick={() => {
            if (!disabled) onSkills(skills.filter((_, position) => position !== index));
          }}><X size={14} />移除当前选择</button>
        </div>;
      })}
      {!styleGroups.length && !skills.length && <p className={styles.muted}>当前未选择风格或提示词组。</p>}
      <p className={styles.muted}>需要替换时，使用“选择风格与提示词”入口添加；未移除的选择仍保留。</p>
    </section>

    <section className={styles.materialSection} aria-label="模板封面修复">
      <div className={styles.materialHeading}><h3>模板封面</h3></div>
      {bannerDisplay && <StudioReferenceGrid items={[bannerDisplay]} compact materialTiles disabled={disabled}
        onChange={next => { if (!disabled && !next.length) onBanner(null); }} onPreview={onPreview}
        renderDetails={image => {
          const issue = pending(bannerSource, image);
          return issue ? <p className={styles.muted} role="status">封面待处理：{issue}。可选择替换或移除当前引用。</p> : null;
        }} />}
      {!banner && <p className={styles.muted}>当前未设置封面。</p>}
      <button type="button" disabled={disabled} onClick={onReplaceBanner}><ImagePlus size={16} />{banner ? '选择替换封面' : '选择封面'}</button>
    </section>
  </>;
}
