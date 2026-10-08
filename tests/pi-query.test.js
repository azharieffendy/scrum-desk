'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const q=require('../public/pi-query');
const source=`project IN ('TOR - SEMERU') AND assignee = 557058:abc AND status = 'DONE' AND ("Start date[Date]" >= '2026-05-01' AND "Start date[Date]" <= '2026-08-31') OR (project IN ('SCRUM - QNB', 'SCRUM - SEMERU', 'SCRUM - BMS', 'QRIS Merchant Bank Kalteng') AND assignee = 557058:abc AND status = 'DONE' AND resolutionDate >= '2026-05-01' AND resolutionDate <= '2026-08-31') ORDER BY created DESC`;
test('converter replaces every selected assignee and date and preserves OR groups',()=>{
 const r=q.convert(source,'557058:abc','2026-05-01','2026-08-31');
 assert.deepEqual(r.replaced,{accounts:2,first:2,last:2});assert.equal(q.validate(r.template).errors.length,0);
 const rules=q.parse(r.template);assert.equal(rules.length,2);assert.equal(rules[0].field,'"Start date[Date]"');assert.equal(rules[1].projects.length,4);
 assert.deepEqual(q.parse(q.build(rules)),rules);
});
test('conversion leaves other assignees, unrelated dates, keywords in quotes and substrings intact',()=>{
 const s=source.replace("status = 'DONE'", "status = 'AND OR DONE'")+" ";
 const r=q.convert(s,'557058:abc','2026-05-01','2026-08-31');assert.match(r.template,/AND OR DONE/);
 assert.deepEqual(q.candidates(source).accounts,['557058:abc']);
 assert.throws(()=>q.convert(source,'different','2026-05-01','2026-08-31'),/must appear/);
 assert.throws(()=>q.convert(source,'557058:abc','2026-05-01','2026-05-01'),/single-day/);
});
test('validation ignores quoted brackets, checks escaping and flags fixed dates/accounts',()=>{
 assert.equal(q.validate("assignee = '{assignee}' AND summary ~ 'literal ( OR )' AND resolved >= '{start}' AND resolved <= '{end}'").errors.length,0);
 assert.match(q.validate("(assignee = '{assignee}' AND x >= '{start}' AND x <= '{end}'").errors.join(' '),/bracket/);
 assert.match(q.validate("assignee = 'broken").errors.join(' '),/quoted/);
 assert.equal(q.validate(source).warnings.length,3);
 assert.equal(q.validate(source).errors.length,3);
});
test('builder refuses unsupported filters and sorting instead of dropping them',()=>{
 const template=q.convert(source,'557058:abc','2026-05-01','2026-08-31').template;
 assert.equal(q.parse(template.replace('status =',"priority = 'High' AND status =")),null);
 assert.equal(q.parse(template.replace('created DESC','updated ASC')),null);
 assert.equal(q.parse("assignee = '{assignee}' AND statusCategory = Done AND resolutionDate >= '{start}' AND resolutionDate < '{afterEnd}'").length,1);
 const r=[{projects:["O'Brien",'QNB','QNB'],category:false,status:'DONE',field:'resolutionDate'}];
 assert.equal(q.parse(q.build(r))[0].projects.length,2);
});
test('a query mixing <= last day and < next day converts both, whichever boundary is chosen',()=>{
 const mixed="(assignee = x AND created >= 2026-05-01 AND created <= 2026-08-31) OR (assignee = x AND resolved >= 2026-05-01 AND resolved < 2026-09-01)";
 for(const end of ['2026-08-31','2026-09-01']){
  const r=q.convert(mixed,'x','2026-05-01',end);
  assert.match(r.template,/created <= '\{end\}'/);assert.match(r.template,/resolved < '\{afterEnd\}'/);
  assert.deepEqual(r.replaced,{accounts:2,first:2,last:2});assert.deepEqual(r.warnings,[]);
 }
 const other=q.convert("assignee = x AND resolved >= 2026-05-01 AND resolved <= 2026-08-31 AND created > 2026-01-15",'x','2026-05-01','2026-08-31');
 assert.match(other.warnings.join(' '),/Fixed date 2026-01-15/);
});
test('functions are not fixed assignees; every literal in assignee IN (...) is',()=>{
 const tail=" AND x >= '{start}' AND x <= '{end}' OR assignee = '{assignee}'";
 assert.deepEqual(q.validate('assignee = currentUser()'+tail).warnings,[]);
 assert.deepEqual(q.candidates('assignee = currentUser() AND assignee IN (membersOf("team"), abc, \'d e\')').accounts,['abc','d e']);
 assert.match(q.validate("assignee IN (abc, '{assignee}')"+tail).warnings.join(' '),/Fixed assignee abc/);
});
test('exclusive upper date converts to afterEnd instead of dropping the final report day',()=>{
 const r=q.convert("assignee = abc AND resolutionDate >= '2026-05-01' AND resolutionDate < '2026-09-01'",'abc','2026-05-01','2026-09-01');
 assert.match(r.template,/resolutionDate < '\{afterEnd\}'/);
 assert.match(q.validate("assignee = '{assignee}' AND cf[123 >= '{start}' AND x <= '{end}'").errors.join(' '),/square bracket/);
});
