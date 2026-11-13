import { buildBatchPlan } from './batch-plan.js';
import { transformWithProfile } from './pipeline.js';

export const BATCH_ALGORITHM = 'activated-world-info-stable-first-v1';
export const EMPTY_BATCH_POLICY = Object.freeze({ enabled:false, version:0, algorithm:BATCH_ALGORITHM, connection:null });

/** Every future request is rebuilt from its OWN activation snapshot. No card text is reused. */
export function runBatchPolicy(body, meta, policy, limits) {
  const result={applied:false,algorithm:BATCH_ALGORITHM,policyVersion:policy?.version??0,selectedEntries:0,selectedGroups:0,reason:'批量排序未启用。'};
  const unchanged=()=>({body,result});
  if(!policy?.enabled)return unchanged();
  if(policy.algorithm!==BATCH_ALGORITHM){result.reason='未知批量策略版本，保持原请求。';return unchanged();}
  if(meta?.purpose!=='main'||policy.connection?.provider!==meta.provider||policy.connection?.model!==meta.model){result.reason='未明确归类为正文，或不是已授权的正文连接。';return unchanged();}
  if(meta.snapshot?.activationEventSeen!==true||!meta.snapshot?.generation||meta.snapshot.generation.dryRun===true){result.reason='未取得当前生成过程的真实世界书激活事件，保持原请求。';return unchanged();}
  const record={...meta,body,observationLevel:'frontend',status:'prepared'};
  const setup={complete:true,optimizationBlocked:false,batchAuthorized:true};
  const plan=buildBatchPlan({record,setup,limits});
  result.selectedEntries=plan.counts.selectedEntries;result.selectedGroups=plan.counts.selectedGroups;
  result.reason=plan.reasons.join('；')||'已检查当前请求中的激活条目。';
  if(plan.input)result.input={upperBound:plan.input.upperBound,ceiling:plan.input.ceiling,exact:false,method:plan.input.method};
  if(!plan.canApply||!plan.preview?.ok)return unchanged();
  const trace={};
  const transformed=transformWithProfile(body,plan.preview.after,{binding:record,record:trace});
  result.applied=trace.structureTransformation?.applied===true;
  result.reason=result.applied?'已对当前请求副本内的合格世界书片段排序；实际费用与剧情质量待正常游玩观察。':trace.structureTransformation?.reason||'运行时校验未通过，保持原请求。';
  result.expectedImpact={newEntries:0,deletedEntries:0,contentBytesAdded:0,rolesChanged:false,nativeSettingsChanged:false,cacheSavingsVerified:false};
  return {body:transformed,result};
}
