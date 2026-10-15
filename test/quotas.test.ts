import {describe,it,expect} from 'vitest';
import {normalizeQuotas,emptyQuota,staleQuota} from '../src/providers/quotas';
import type {GetAccountResponse} from '../src/protocol/generated/v2/GetAccountResponse';
import type {GetAccountRateLimitsResponse} from '../src/protocol/generated/v2/GetAccountRateLimitsResponse';
import {aggregate} from '../src/analytics/aggregate';
import {renderDashboard} from '../src/webview/html';
import type * as vscode from 'vscode';
const account={account:{type:'chatgpt',email:'should-not-be-rendered@example.com',planType:'plus'},requiresOpenaiAuth:true} as GetAccountResponse;
const limits={ordinaryUsageAllowed:false,accountId:'test-account',rateLimits:{limitId:'codex',limitName:'Codex',normalModelSlug:null,primary:{usedPercent:100,windowDurationMins:300,resetsAt:1790000000},secondary:{usedPercent:16,windowDurationMins:10080,resetsAt:1790500000},credits:null,individualLimit:null,spendControlReached:null,planType:'plus',rateLimitReachedType:null},rateLimitsByLimitId:null,rateLimitResetCredits:null,rateLimitUpsell:null} as GetAccountRateLimitsResponse;
describe('quota adapter',()=>{
 it('normalizes 5-hour and weekly quotas separately',()=>{
  const result=normalizeQuotas(account,limits);
  expect(result.state).toBe('connected');expect(result.plan).toBe('plus');expect(result.ordinaryUsageAllowed).toBe(false);
  expect(result.buckets[0].windows).toMatchObject([{usedPercent:100,durationMinutes:300},{usedPercent:16,durationMinutes:10080}]);
 });
 it('does not lose additional bucket limits',()=>{
  const result=normalizeQuotas(account,{...limits,rateLimitsByLimitId:{codex:limits.rateLimits,other:{...limits.rateLimits,limitId:'other',limitName:'Other',primary:{usedPercent:40,windowDurationMins:60,resetsAt:1790000000}}}});
  expect(result.buckets.map(b=>b.id)).toEqual(['codex','other']);
 });
 it('does not send account email to the dashboard',()=>{
  const result=normalizeQuotas(account,limits);
  expect(JSON.stringify(result)).not.toContain('should-not-be-rendered@example.com');
 });
 it('applies a restrictive Webview CSP',()=>{
  const mock={asWebviewUri:(u:{toString():string})=>u,cspSource:'vscode-resource:'} as unknown as vscode.Webview;
  const uri={path:'/extension',with:({path}:{path:string})=>({toString:()=>`vscode-resource:${path}`})} as vscode.Uri;
  const html=renderDashboard(mock,uri);
  expect(html).toContain("default-src 'none'");expect(html).toContain("connect-src 'none'");expect(html).not.toContain('unsafe-inline');
 });
 it('uses explicit signed-out state',()=>expect(emptyQuota('signed-out').state).toBe('signed-out'));
 it('retains the last successful sample with an explicit stale state',()=>{const fresh=normalizeQuotas(account,limits),stale=staleQuota(fresh,'offline');expect(stale.state).toBe('stale');expect(stale.fetchedAt).toBe(fresh.fetchedAt);expect(stale.buckets).toEqual(fresh.buckets);});
});
describe('incomplete App Server responses',()=>{
 it('handles missing quota snapshots as an empty connected state',()=>{const result=normalizeQuotas(account,{ordinaryUsageAllowed:true,rateLimitsByLimitId:null} as unknown as GetAccountRateLimitsResponse);expect(result.state).toBe('connected');expect(result.buckets).toEqual([]);});
});
