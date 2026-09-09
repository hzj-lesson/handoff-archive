#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hzj-lesson 的 GitHub 连接器 —— 一个脚本搞定「看 / 拉 / 推」。

先设置 token（每个新沙箱一次）：
    export GH_TOKEN=$(cat /tmp/gh_token)
  或写入 /tmp/gh_token 文件，脚本会自动读。

命令：
    gh.py status                          全部仓库总览（含 Pages 网址、最近提交）
    gh.py list                            列出所有仓库
    gh.py ls  <repo> [路径]                列出仓库文件
    gh.py pull <repo> <路径> [本地路径]     下载单个文件
    gh.py clone <repo> [本地目录]           下载整个仓库（tarball，不用 git）
    gh.py push <repo> <本地>=<路径> --msg   上传文件（同 deploy.py）
    gh.py log  <repo> [条数]                查看提交历史
    gh.py pages <repo>                     查看 Pages 部署状态
    gh.py repos                             只打印仓库名（方便脚本里循环）

repo 可以简写：bigdata-excel-contest 会自动补成 hzj-lesson/bigdata-excel-contest
"""
import argparse, base64, io, json, os, sys, tarfile, time, urllib.request, urllib.error, urllib.parse

OWNER = 'hzj-lesson'
HDR = {'Accept': 'application/vnd.github+json', 'User-Agent': 'gh-tool', 'Connection': 'close'}


def get_token():
    t = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if t:
        return t.strip()
    for p in ('/tmp/gh_token', os.path.expanduser('~/.gh_token')):
        if os.path.exists(p):
            return open(p).read().strip()
    sys.exit('❌ 找不到 token：export GH_TOKEN=ghp_xxx  或写入 /tmp/gh_token')


class GH:
    def __init__(self, token):
        self.api = 'https://api.github.com'
        self.h = dict(HDR)
        self.h['Authorization'] = 'Bearer ' + token

    @staticmethod
    def enc(p):
        return urllib.parse.quote(p, safe='/')

    def req(self, url, data=None, method=None, raw=False, retries=5):
        last = None
        for i in range(retries):
            try:
                r = urllib.request.Request(url, data=data, headers=self.h, method=method)
                with urllib.request.urlopen(r, timeout=90) as resp:
                    b = resp.read()
                    return b if raw else json.loads(b.decode('utf-8'))
            except urllib.error.HTTPError as e:
                body = e.read().decode('utf-8', 'ignore')
                last = 'HTTP %s: %s' % (e.code, body[:300])
                if e.code in (429, 502, 503, 504):
                    time.sleep(15 if e.code == 429 else 5)
                    continue
                sys.exit('❌ ' + last)
            except Exception as e:
                last = str(e)
                if 'IncompleteRead' in last or 'RemoteDisconnected' in last or 'timed out' in last:
                    time.sleep(3)
                    continue          # 沙箱网络常见：响应被截断，重试即可
                sys.exit('❌ ' + last)
        sys.exit('❌ 重试耗尽：' + str(last)[:200])


def full(repo):
    return repo if '/' in repo else '%s/%s' % (OWNER, repo)


# ---------------- 各子命令 ----------------
def cmd_status(gh, a):
    repos = gh.req(gh.api + '/users/%s/repos?per_page=100&sort=pushed' % OWNER)
    print('%-42s %-8s %-22s %s' % ('仓库', '可见性', '最近推送', 'Pages'))
    print('-' * 100)
    for r in sorted(repos, key=lambda x: x['pushed_at'], reverse=True):
        pages = '—'
        try:
            pg = gh.req(gh.api + '/repos/%s/pages' % r['full_name'])
            pages = pg.get('html_url', '—').replace('https://', '')
            if pg.get('status') != 'built':
                pages += '  [' + str(pg.get('status')) + ']'
        except SystemExit:
            pass
        except Exception:
            pass
        print('%-42s %-8s %-22s %s' % (r['name'], r['visibility'], r['pushed_at'][:19].replace('T', ' '), pages))
    print('\n共 %d 个仓库' % len(repos))


def cmd_list(gh, a):
    repos = gh.req(gh.api + '/users/%s/repos?per_page=100&sort=pushed' % OWNER)
    for r in sorted(repos, key=lambda x: x['pushed_at'], reverse=True):
        print('%-40s %-10s %s' % (r['full_name'], r['pushed_at'][:10], (r['description'] or '')[:60]))


def cmd_repos(gh, a):
    for r in gh.req(gh.api + '/users/%s/repos?per_page=100' % OWNER):
        print(r['name'])


def cmd_ls(gh, a):
    repo = full(a.repo)
    url = gh.api + '/repos/%s/contents/%s?ref=%s' % (repo, gh.enc(a.path or ''), a.branch)
    try:
        items = gh.req(url)
    except SystemExit as e:
        sys.exit('❌ 路径不存在或不是目录：%s' % (a.path or '/'))
    if isinstance(items, dict):
        items = [items]
    for it in items:
        kind = '📁' if it['type'] == 'dir' else '📄'
        size = ('%8d' % it.get('size', 0)) if it['type'] == 'file' else '       -'
        print('%s %s %s  %s' % (kind, size, it['path'], ''))


def cmd_pull(gh, a):
    repo = full(a.repo)
    dest = a.dest or os.path.basename(a.path)
    url = gh.api + '/repos/%s/contents/%s?ref=%s' % (repo, gh.enc(a.path), a.branch)
    info = gh.req(url)
    if isinstance(info, list):
        sys.exit('❌ 这是目录，请用 clone 下载整个仓库')
    if info.get('encoding') == 'base64':
        data = base64.b64decode(info['content'])
    else:
        data = gh.req(info['download_url'], raw=True)
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    open(dest, 'wb').write(data)
    print('✅ %s (%d 字节) -> %s' % (a.path, len(data), dest))
    if len(data) != info.get('size'):
        print('⚠️  字节数不一致：线上 %s / 实际 %d' % (info.get('size'), len(data)))


def cmd_clone(gh, a):
    repo = full(a.repo)
    dest = a.dest or repo.split('/')[1]
    os.makedirs(dest, exist_ok=True)
    tgz = gh.req(gh.api + '/repos/%s/tarball/%s' % (repo, a.branch), raw=True)
    n = 0
    with tarfile.open(fileobj=io.BytesIO(tgz), mode='r:gz') as tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue
            p = os.path.join(*m.name.split('/')[1:])   # 去掉顶层 名字-哈希/ 目录
            out = os.path.join(dest, p)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            f = tf.extractfile(m)
            if f:
                open(out, 'wb').write(f.read())
                n += 1
    print('✅ %s -> %s （%d 个文件）' % (repo, os.path.abspath(dest), n))


def cmd_push(gh, a):
    repo = full(a.repo)
    head = gh.req(gh.api + '/repos/%s/git/refs/heads/%s' % (repo, a.branch))
    base_sha = head['object']['sha']
    base_tree = gh.req(gh.api + '/repos/%s/git/commits/%s' % (repo, base_sha))['tree']['sha']
    tree = []
    for m in a.map:
        local, path = (m.split('=', 1) + [None])[:2]
        path = path or os.path.basename(local)
        if not os.path.exists(local):
            sys.exit('❌ 本地文件不存在：' + local)
        content = open(local, 'rb').read()
        blob = gh.req(gh.api + '/repos/%s/git/blobs' % repo,
                      json.dumps({'content': base64.b64encode(content).decode(),
                                  'encoding': 'base64'}).encode(), 'POST')
        tree.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        print('  📦 %-42s %8d 字节' % (path, len(content)))
    new_tree = gh.req(gh.api + '/repos/%s/git/trees' % repo,
                      json.dumps({'base_tree': base_tree, 'tree': tree}).encode(), 'POST')
    cm = gh.req(gh.api + '/repos/%s/git/commits' % repo,
                json.dumps({'message': a.msg, 'tree': new_tree['sha'],
                            'parents': [base_sha]}).encode(), 'POST')
    gh.req(gh.api + '/repos/%s/git/refs/heads/%s' % (repo, a.branch),
           json.dumps({'sha': cm['sha']}).encode(), 'PATCH')
    print('✅ 已部署 commit: %s' % cm['sha'])
    print('--- 校验（用 size 字段，别用 base64 解码长度）---')
    ok = True
    for m in a.map:
        local, path = (m.split('=', 1) + [None])[:2]
        path = path or os.path.basename(local)
        lb = os.path.getsize(local)
        info = gh.req(gh.api + '/repos/%s/contents/%s?ref=%s' % (repo, gh.enc(path), a.branch))
        same = info['size'] == lb
        ok = ok and same
        print('  %-42s 线上 %-9d 本地 %-9d %s' % (path, info['size'], lb, '✅' if same else '❌'))
    print('结果：%s' % ('✅ 全部一致' if ok else '❌ 有文件不一致，请重跑'))


def cmd_log(gh, a):
    repo = full(a.repo)
    for c in gh.req(gh.api + '/repos/%s/commits?per_page=%d&sha=%s' % (repo, a.n, a.branch)):
        msg = c['commit']['message'].splitlines()[0][:66]
        print('%s  %s  %s' % (c['sha'][:8], c['commit']['author']['date'][:19].replace('T', ' '), msg))


def cmd_pages(gh, a):
    repo = full(a.repo)
    try:
        pg = gh.req(gh.api + '/repos/%s/pages' % repo)
    except SystemExit:
        sys.exit('❌ %s 未开启 Pages' % repo)
    print('网址   : %s' % pg.get('html_url'))
    print('状态   : %s' % pg.get('status'))
    print('分支   : %s / %s' % (pg.get('source', {}).get('branch'), pg.get('source', {}).get('path')))
    builds = gh.req(gh.api + '/repos/%s/pages/builds?per_page=3' % repo)
    if builds:
        print('最近构建:')
        for b in builds:
            print('   %s  %s  %s' % (b['status'], b.get('duration', '—'), b['created_at'][:19].replace('T', ' ')))


def main():
    ap = argparse.ArgumentParser(description='hzj-lesson GitHub 连接器',
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)

    sub.add_parser('status', help='全部仓库总览').set_defaults(f=cmd_status)
    sub.add_parser('list', help='列出所有仓库').set_defaults(f=cmd_list)
    sub.add_parser('repos', help='只打印仓库名').set_defaults(f=cmd_repos)

    p = sub.add_parser('ls', help='列出仓库文件'); p.add_argument('repo'); p.add_argument('path', nargs='?', default='')
    p.add_argument('--branch', default='main'); p.set_defaults(f=cmd_ls)

    p = sub.add_parser('pull', help='下载单个文件'); p.add_argument('repo'); p.add_argument('path')
    p.add_argument('dest', nargs='?'); p.add_argument('--branch', default='main'); p.set_defaults(f=cmd_pull)

    p = sub.add_parser('clone', help='下载整个仓库(tarball)'); p.add_argument('repo'); p.add_argument('dest', nargs='?')
    p.add_argument('--branch', default='main'); p.set_defaults(f=cmd_clone)

    p = sub.add_parser('push', help='上传文件'); p.add_argument('repo'); p.add_argument('map', nargs='+')
    p.add_argument('--msg', default='chore: update via gh.py'); p.add_argument('--branch', default='main')
    p.set_defaults(f=cmd_push)

    p = sub.add_parser('log', help='提交历史'); p.add_argument('repo'); p.add_argument('n', nargs='?', type=int, default=10)
    p.add_argument('--branch', default='main'); p.set_defaults(f=cmd_log)

    p = sub.add_parser('pages', help='Pages 状态'); p.add_argument('repo'); p.set_defaults(f=cmd_pages)

    a = ap.parse_args()
    a.f(GH(get_token()), a)


if __name__ == '__main__':
    main()
