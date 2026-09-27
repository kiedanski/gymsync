import { createWidget, widget, align, prop } from '@zos/ui'
import { back } from '@zos/router'
import { history } from '../libs/store'

// Recent readings, newest first, paged six at a time. Entries come from the
// local log in libs/store (the sync queue is emptied on ack, so it cannot be
// the source here). The PC keeps the full archive.
const PAGE_SIZE = 6
const ROW_Y = 112
const ROW_STEP = 40

const COLOR_TITLE = 0x6c7581
const COLOR_DIM = 0xc4cbd4
const COLOR_UP = 0xe7a13c
const COLOR_DOWN = 0x35c4b6
const COLOR_FLAT = 0x6c7581

// Module scope: assignments to `this` inside Page methods do not persist.
let offset = 0
let entries = []
let rows = []
let subtitleW = null

function fmt(v) {
  return v.toFixed(1)
}

function round1(v) {
  return Math.round(v * 10) / 10
}

function dateLabel(t) {
  try {
    const d = new Date(t * 1000)
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2)
  } catch (e) {
    return '--/--'
  }
}

function render() {
  const total = entries.length
  if (subtitleW) {
    if (total === 0) {
      subtitleW.setProperty(prop.TEXT, 'no readings yet')
    } else {
      const from = Math.min(offset + 1, total)
      const to = Math.min(offset + PAGE_SIZE, total)
      subtitleW.setProperty(prop.TEXT, from + '–' + to + ' of ' + total)
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const e = entries[offset + i]
    const row = rows[i]
    if (!e) {
      row.date.setProperty(prop.TEXT, '')
      row.kg.setProperty(prop.TEXT, '')
      row.delta.setProperty(prop.TEXT, '')
      continue
    }
    row.date.setProperty(prop.TEXT, dateLabel(e.t))
    row.kg.setProperty(prop.TEXT, fmt(e.k) + ' kg')

    // Compare against the next older reading.
    const prev = entries[offset + i + 1]
    if (!prev) {
      row.delta.setProperty(prop.TEXT, '')
    } else {
      const d = round1(e.k - prev.k)
      if (d > 0.001) {
        row.delta.setProperty(prop.TEXT, '▲' + fmt(Math.abs(d)))
        row.delta.setProperty(prop.COLOR, COLOR_UP)
      } else if (d < -0.001) {
        row.delta.setProperty(prop.TEXT, '▼' + fmt(Math.abs(d)))
        row.delta.setProperty(prop.COLOR, COLOR_DOWN)
      } else {
        row.delta.setProperty(prop.TEXT, '=')
        row.delta.setProperty(prop.COLOR, COLOR_FLAT)
      }
    }
  }
}

function pageBy(delta) {
  const next = offset + delta
  if (next < 0 || next >= entries.length) return
  offset = next
  render()
}

Page({
  onInit() {
    entries = history().slice().reverse() // newest first
    offset = 0
  },

  build() {
    createWidget(widget.TEXT, {
      x: 0, y: 34, w: 480, h: 32, text: 'HISTORY',
      text_size: 26, color: COLOR_TITLE, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    subtitleW = createWidget(widget.TEXT, {
      x: 0, y: 70, w: 480, h: 28, text: '',
      text_size: 20, color: COLOR_TITLE, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    rows = []
    for (let i = 0; i < PAGE_SIZE; i++) {
      const y = ROW_Y + i * ROW_STEP
      rows.push({
        date: createWidget(widget.TEXT, {
          x: 60, y: y, w: 90, h: 34, text: '',
          text_size: 22, color: COLOR_TITLE, align_h: align.LEFT, align_v: align.CENTER_V,
        }),
        kg: createWidget(widget.TEXT, {
          x: 150, y: y, w: 160, h: 34, text: '',
          text_size: 26, color: COLOR_DIM, align_h: align.CENTER_H, align_v: align.CENTER_V,
        }),
        delta: createWidget(widget.TEXT, {
          x: 310, y: y, w: 110, h: 34, text: '',
          text_size: 22, color: COLOR_FLAT, align_h: align.RIGHT, align_v: align.CENTER_V,
        }),
      })
    }

    createWidget(widget.BUTTON, {
      x: 93, y: 368, w: 90, h: 62, text: '‹', text_size: 30,
      normal_color: 0x333b44, press_color: 0x4c5560, radius: 31,
      click_func: () => pageBy(-PAGE_SIZE),
    })
    createWidget(widget.BUTTON, {
      x: 195, y: 368, w: 90, h: 62, text: 'BACK', text_size: 20,
      normal_color: 0x333b44, press_color: 0x4c5560, radius: 31,
      click_func: () => back(),
    })
    createWidget(widget.BUTTON, {
      x: 297, y: 368, w: 90, h: 62, text: '›', text_size: 30,
      normal_color: 0x333b44, press_color: 0x4c5560, radius: 31,
      click_func: () => pageBy(PAGE_SIZE),
    })

    render()
  },

  onDestroy() {
    rows = []
    entries = []
    subtitleW = null
  },
})
