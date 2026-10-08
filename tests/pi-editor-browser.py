"""Performance settings interactions using synthetic intercepted API/JIRA responses."""
from pathlib import Path
from urllib.parse import urlparse
import mimetypes
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]/'public'
OUT=Path('/tmp/daily-scrum-pi-editor');OUT.mkdir(exist_ok=True)
SOURCE="project IN ('TOR - SEMERU') AND assignee = 557058:abc AND status = 'DONE' AND (\"Start date[Date]\" >= '2026-05-01' AND \"Start date[Date]\" <= '2026-08-31') OR (project IN ('SCRUM - QNB', 'SCRUM - SEMERU', 'SCRUM - BMS', 'QRIS Merchant Bank Kalteng') AND assignee = 557058:abc AND status = 'DONE' AND resolutionDate >= '2026-05-01' AND resolutionDate <= '2026-08-31') ORDER BY created DESC"
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[];writes=[];tests=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    def route(r):
        u=urlparse(r.request.url)
        if u.netloc!='scrum.test':r.abort();return
        if u.path=='/api/auth/status':r.fulfill(json={'authenticated':False,'needsSetup':False});return
        if u.path=='/api/pi/test':
            body=r.request.post_data_json;tests.append(body)
            r.fulfill(json={'person':'Ferdinand','period':body['period'],'label':'May – Aug 2026','count':70,'testedAt':'2026-10-08T03:00:00Z','jql':body['template'].replace('{assignee}','557058:abc').replace('{start}','2026-05-01').replace('{end}','2026-08-31'),'url':'https://example.atlassian.net/issues/?jql=test'});return
        if u.path=='/api/pi/options':
            r.fulfill(json={'projects':[{'value':'TOR','name':'TOR - SEMERU'},{'value':'QNB','name':'SCRUM - QNB'},{'value':'SEM','name':'SCRUM - SEMERU'},{'value':'BMS','name':'SCRUM - BMS'},{'value':'QRIS','name':'QRIS Merchant Bank Kalteng'}],'statuses':['DONE'],'fields':[{'value':'resolutionDate','name':'Resolved date'},{'value':'cf[10015]','name':'Start date'}]});return
        if u.path=='/api/state' and r.request.method=='PUT':writes.append(r.request.post_data_json);r.fulfill(json={'version':len(writes)});return
        if u.path.startswith('/api/'):r.fulfill(json={});return
        f=ROOT/(u.path.lstrip('/') or 'index.html')
        if f.is_file():r.fulfill(body=f.read_bytes(),content_type=mimetypes.guess_type(str(f))[0] or 'text/plain')
        else:r.fulfill(status=404)
    page.route('**/*',route)
    page.goto('http://scrum.test',wait_until='networkidle')
    page.evaluate("""() => {auth={name:'Demo',role:'admin',memberId:'m1'};storageMode='server';state.members=[{id:'m1',name:'Ferdinand',email:'demo@example.test',color:'#1066A0'}];state.mapping={'557058:abc':'m1'};state.settings={piPeriodMonths:4,kpiMembers:['m1']};lastSavedState=clone(state);lastSavedExtras=saveExtrasKey();piUi.period='2026-P2';ui.view='settings';ui.settingsTab='reports';document.body.classList.remove('auth-mode');render();} """)
    expect(page.get_by_text('Built-in query',exact=True)).to_be_visible()
    page.get_by_text('Paste a JIRA query',exact=True).click()
    page.locator('#piSource').fill(SOURCE)
    page.get_by_role('button',name='Find account and dates').click()
    expect(page.locator('#piConvertAccount')).to_have_value('557058:abc')
    page.get_by_role('button',name='Review conversion').click()
    page.get_by_role('button',name='Use this template').click()
    assert not writes
    expect(page.locator('#piDraftStatus')).to_have_text('Unsaved changes')
    page.locator('#piPreviewMember').select_option('m1')
    page.get_by_role('button',name='Test query',exact=True).click()
    expect(page.locator('#piTestResult')).to_contain_text('70 tickets')
    assert len(tests)==1 and tests[0]['template']==page.locator('#piJql').input_value()
    expect(page.get_by_role('link',name='Open in JIRA')).to_be_visible()
    converted=page.locator('#piJql').input_value()
    page.locator('#piJql').fill('broken (')
    expect(page.locator('#piValidation')).to_contain_text('bracket')
    expect(page.locator('#piSave')).to_be_disabled()
    expect(page.locator('#piTestResult')).to_be_empty()
    page.locator('#piJql').fill(converted)
    page.get_by_role('button',name='Build with rules',exact=True).click()
    expect(page.locator('.pi-rule')).to_have_count(2)
    page.get_by_role('button',name='Load projects, statuses and date fields from JIRA').click()
    page.locator('[data-pi-rule="0"][data-pi-part="field"]').select_option('cf[10015]')
    assert 'cf[10015]' in page.locator('#piJql').input_value()
    page.get_by_role('button',name='+ Add rule').click()
    expect(page.locator('.pi-rule')).to_have_count(3)
    page.locator('[data-action="pi-rule-remove"]').last.click()
    expect(page.locator('.pi-rule')).to_have_count(2)
    page.get_by_role('button',name='Edit JQL directly',exact=True).click()
    page.locator('#piJql').fill(converted)
    page.get_by_role('button',name='Save changes',exact=True).click()
    expect(page.locator('#piDraftStatus')).to_have_text('Saved · custom team query')
    assert len(writes)==1
    page.locator('#piJql').fill(converted.replace('ORDER BY created DESC',"AND priority = 'High' ORDER BY created DESC"))
    complex_query=page.locator('#piJql').input_value()
    page.get_by_role('button',name='Build with rules',exact=True).click()
    expect(page.locator('#piJql')).to_have_value(complex_query)
    expect(page.locator('.pi-editor')).to_contain_text('cannot represent')
    page.get_by_role('button',name='Discard',exact=True).click()
    expect(page.locator('#piJql')).to_have_value(converted)
    for width in (1440,780,320):
        page.set_viewport_size({'width':width,'height':1100})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),f'overflow at {width}'
        page.screenshot(path=str(OUT/f'performance-settings-{width}.png'),full_page=True)
    assert not errors,errors
    browser.close()
print('Performance converter, draft count, validation, builder, save/discard and responsive checks passed')
