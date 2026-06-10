// The Board: observations & suggestions that aren't paid tasks but can graduate
// into one. List, create, comment, toggle "I'll help", and "Turn into a gig".

import { ApiError, api } from './api.js'
import { getUser } from './auth.js'
import { requestGeolocation } from './location.js'
import { nameLink } from './profile.js'
import { clear, emptyState, errorState, fmtDate, h, spinner, toast } from './ui.js'

// main.js wires this so "Turn into a gig" can prefill the Post screen and switch tabs.
let onTurnIntoGig = null
export function setOnTurnIntoGig(fn) {
  onTurnIntoGig = fn
}

let listEl = null

export function renderBoard(root) {
  clear(root)
  root.append(h('h1', { class: 'screen-title' }, 'Board'))
  root.append(composer())
  listEl = h('div', { class: 'list' })
  root.append(listEl)
  load()
}

function composer() {
  const body = h('textarea', {
    class: 'input',
    rows: '3',
    placeholder: 'Share an observation or a “wouldn’t it look better if…”',
  })
  const area = h('input', { class: 'input', type: 'text', placeholder: 'Area label (optional)' })
  const pin = { lat: null, lng: null }
  const pinBtn = h(
    'button',
    { type: 'button', class: 'btn-ghost', onClick: locate },
    'Use my location',
  )
  async function locate() {
    pinBtn.textContent = 'Locating…'
    try {
      const c = await requestGeolocation()
      pin.lat = c.lat
      pin.lng = c.lng
      pinBtn.textContent = 'Location set'
    } catch (err) {
      pinBtn.textContent = 'Use my location'
      toast(err.message, 'error')
    }
  }
  const postBtn = h('button', { class: 'btn-primary', type: 'submit' }, 'Post to board')
  return h(
    'form',
    {
      class: 'card form',
      onSubmit: async (e) => {
        e.preventDefault()
        const text = body.value.trim()
        if (!text) return toast('Write something first', 'error')
        postBtn.disabled = true
        postBtn.textContent = 'Posting…'
        try {
          await api.createPost({
            body: text,
            area_label: area.value.trim() || null,
            lat: pin.lat,
            lng: pin.lng,
          })
          body.value = ''
          area.value = ''
          pin.lat = pin.lng = null
          pinBtn.textContent = 'Use my location'
          toast('Posted to the board')
          load()
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not post', 'error')
        } finally {
          postBtn.disabled = false
          postBtn.textContent = 'Post to board'
        }
      },
    },
    body,
    area,
    h('div', { class: 'loc' }, pinBtn),
    postBtn,
  )
}

async function load() {
  if (!listEl) return
  clear(listEl)
  listEl.append(spinner('Loading the board…'))
  try {
    const posts = await api.posts()
    clear(listEl)
    if (!posts.length) {
      listEl.append(emptyState('Nothing on the board yet — be the first to post.'))
      return
    }
    for (const p of posts) listEl.append(postCard(p))
    attachLoadMore(posts)
  } catch (err) {
    clear(listEl)
    listEl.append(errorState(err instanceof ApiError ? err.message : 'Could not load board', load))
  }
}

const PAGE = 20

// Keyset "load more": only when the last batch filled a page.
function attachLoadMore(batch) {
  if (batch.length < PAGE) return
  const btn = h('button', { class: 'btn-ghost load-more' }, 'Load more')
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      const more = await api.posts(batch[batch.length - 1].created_at)
      for (const p of more) listEl.insertBefore(postCard(p), btn)
      btn.remove()
      attachLoadMore(more)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load more', 'error')
      btn.disabled = false
    }
  })
  listEl.append(btn)
}

function postCard(p) {
  const card = h('div', { class: 'card post-card' })
  const header = h(
    'div',
    { class: 'post-head' },
    h('span', { class: 'post-author' }, nameLink(p.author_name, p.author_id, p.author_verified)),
    p.area_label ? h('span', { class: 'post-area' }, p.area_label) : null,
  )
  const bodyEl = h('p', { class: 'post-body' }, p.body)
  const counts = h(
    'div',
    { class: 'post-counts' },
    `${p.comment_count} comment${p.comment_count === 1 ? '' : 's'} · ${p.interest_count} helping${p.gig_count > 0 ? ' · now a gig' : ''}`,
  )

  const expandWrap = h('div', { class: 'post-expand hidden' })
  let expanded = false
  let loaded = false

  header.addEventListener('click', toggle)
  bodyEl.addEventListener('click', toggle)
  counts.addEventListener('click', toggle)

  async function toggle() {
    expanded = !expanded
    expandWrap.classList.toggle('hidden', !expanded)
    if (expanded && !loaded) {
      loaded = true
      await renderExpanded(p, expandWrap, load)
    }
  }

  card.append(header, bodyEl, counts, expandWrap)
  return card
}

async function renderExpanded(p, wrap, reloadList) {
  clear(wrap)
  wrap.append(spinner('Loading…'))
  let full
  try {
    full = await api.post(p.id)
  } catch (err) {
    clear(wrap)
    wrap.append(errorState('Could not load post', () => renderExpanded(p, wrap, reloadList)))
    return
  }
  clear(wrap)
  const me = getUser()

  // "I'll help" toggle
  let interested = !!full.i_am_interested
  const helpBtn = h('button', { class: 'btn-ghost' }, '')
  function paintHelp() {
    helpBtn.textContent = interested ? 'Helping' : 'I’ll help'
    helpBtn.classList.toggle('on', interested)
  }
  paintHelp()
  helpBtn.addEventListener('click', async () => {
    helpBtn.disabled = true
    try {
      if (interested) await api.removeInterest(p.id)
      else await api.addInterest(p.id)
      interested = !interested
      paintHelp()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update', 'error')
    } finally {
      helpBtn.disabled = false
    }
  })

  const turnBtn = h(
    'button',
    {
      class: 'btn-primary',
      onClick: () => {
        if (onTurnIntoGig) {
          onTurnIntoGig({
            from_post_id: p.id,
            description: full.body,
            neighborhood: full.area_label || '',
            lat: full.lat,
            lng: full.lng,
          })
        }
      },
    },
    full.gig_count > 0 ? 'Post another gig from this' : 'Turn into a gig',
  )

  const reportBtn = h(
    'button',
    {
      class: 'link-btn danger',
      onClick: async () => {
        const reason = prompt('Why are you reporting this post?')
        if (!reason || !reason.trim()) return
        try {
          await api.report('post', p.id, reason.trim())
          toast('Reported — an admin will review it')
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not report', 'error')
        }
      },
    },
    'Report',
  )
  const actions = h('div', { class: 'post-actions' }, helpBtn, turnBtn, reportBtn)

  // owner controls
  if (me && full.author_id === me.id) {
    actions.append(
      h(
        'button',
        {
          class: 'btn-ghost',
          onClick: () => openEditPost(full, wrap, reloadList, () => refresh()),
        },
        'Edit',
      ),
      h(
        'button',
        {
          class: 'btn-ghost danger',
          onClick: async () => {
            try {
              await api.deletePost(p.id)
              toast('Post deleted')
              reloadList()
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'Could not delete', 'error')
            }
          },
        },
        'Delete',
      ),
    )
  }

  // comments
  const commentList = h('div', { class: 'comments' })
  for (const cm of full.comments || [])
    commentList.append(commentRow(cm, me, reloadList, () => refresh()))

  const commentInput = h('input', { class: 'input', type: 'text', placeholder: 'Add a comment…' })
  const commentForm = h(
    'form',
    {
      class: 'comment-form',
      onSubmit: async (e) => {
        e.preventDefault()
        const text = commentInput.value.trim()
        if (!text) return
        try {
          await api.addComment(p.id, text)
          commentInput.value = ''
          await refresh()
          reloadList()
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not comment', 'error')
        }
      },
    },
    commentInput,
    h('button', { class: 'btn-ghost', type: 'submit' }, 'Send'),
  )

  async function refresh() {
    await renderExpanded(p, wrap, reloadList)
  }

  wrap.append(actions, commentList, commentForm)
}

function commentRow(cm, me, reloadList, refresh) {
  const row = h(
    'div',
    { class: 'comment' },
    h(
      'span',
      { class: 'comment-author' },
      nameLink(cm.author_name, cm.author_id, cm.author_verified),
    ),
    h('span', { class: 'comment-body' }, cm.body),
    h('span', { class: 'comment-date' }, fmtDate(cm.created_at)),
  )
  if (me && cm.author_id === me.id) {
    row.append(
      h(
        'button',
        {
          class: 'link-btn danger',
          onClick: async () => {
            try {
              await api.deleteComment(cm.id)
              await refresh()
              reloadList()
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'Could not delete', 'error')
            }
          },
        },
        'delete',
      ),
    )
  }
  return row
}

// Inline editor for your own post (body + optional area label).
function openEditPost(full, wrap, reloadList, refresh) {
  const body = h('textarea', { class: 'input', rows: '3' })
  body.value = full.body
  const area = h('input', { class: 'input', type: 'text', placeholder: 'Area label (optional)' })
  if (full.area_label) area.value = full.area_label
  const save = h('button', { class: 'btn-primary', type: 'submit' }, 'Save changes')
  const cancel = h(
    'button',
    { class: 'btn-ghost', type: 'button', onClick: () => refresh() },
    'Cancel',
  )
  const form = h(
    'form',
    {
      class: 'form',
      onSubmit: async (e) => {
        e.preventDefault()
        const text = body.value.trim()
        if (!text) return toast('Post can’t be empty', 'error')
        save.disabled = true
        try {
          await api.updatePost(full.id, text, area.value.trim() || null)
          toast('Post updated')
          await refresh()
          reloadList()
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not save', 'error')
          save.disabled = false
        }
      },
    },
    body,
    area,
    h('div', { class: 'post-actions' }, save, cancel),
  )
  clear(wrap)
  wrap.append(form)
}
