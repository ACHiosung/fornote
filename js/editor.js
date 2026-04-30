/**
 * Editor - 캔버스 클릭/드래그, 모드 전환 관리
 */

class Editor {
    constructor(canvasId, noteData, renderer) {
        this.canvas = document.getElementById(canvasId);
        this.noteData = noteData;
        this.renderer = renderer;

        // 상태 변수
        this.currentMode = 'write';    // write, delete  (노트 모드 내 서브 모드)
        this.editorMode  = 'note';     // note, edit      (최상위 에디터 모드)

        /** Player 인스턴스 참조 (app.js에서 주입). 재생 중 휠 이동에 사용 */
        this.player = null;

        // ── 노트 모드 드래그 상태 ──
        this.isDragging = false;
        this.dragStartAbsSlot = -1;
        this.dragStartLaneName = '';
        this.dragMoved = false;

        // ── 편집 모드: 단일 노트 드래그 상태 ──
        this.editDrag = null;
        this.editDragCurAbsSlot = -1;
        this.editDragCurLaneIdx = -1;

        // ── 편집 모드: 범위 선택 드래그 상태 ──
        // { startX, startY, curX, curY }  (canvas 픽셀 좌표)
        this.rectSel = null;

        // ── 편집 모드: 선택된 노트 집합 ──
        // { notes: [...], minLaneIdx, maxLaneIdx, minAbsSlot, maxAbsSlot }
        this.selection = null;

        // ── 편집 모드: 다중 노트 이동 드래그 상태 ──
        // { anchorLaneIdx, anchorAbsSlot, curLaneIdx, curAbsSlot }
        this.multiDrag = null;

        // ── 클립보드 (Ctrl+C / Ctrl+V) ──
        // { notes: [...], anchorAbsSlot: number }
        this.clipboard = null;

        // 노트 바 높이 계산 상수
        this.NOTE_MIN_HEIGHT        = 6;   // 최소 노트 높이 (px)
        this.NOTE_HEIGHT_RATIO      = 0.4; // slotHeight 대비 노트 높이 비율
        this.MIN_RECT_SEL_SIZE      = 3;   // 범위 선택 최소 드래그 크기 (px)
        this.SELECTION_HIT_PADDING  = 8;   // 선택 영역 클릭 허용 여백 (px)

        // Ln / Drg 레인 그룹 인덱스 범위 — renderer.laneNames 배열에서 동적으로 도출
        const lns  = renderer.laneNames.reduce((acc, n, i) => n.startsWith('lane_') ? [...acc, i] : acc, []);
        const drgs = renderer.laneNames.reduce((acc, n, i) => n.startsWith('drag_') ? [...acc, i] : acc, []);
        this.LN_IDX_MIN  = lns.length  > 0 ? lns[0]  : 0;
        this.LN_IDX_MAX  = lns.length  > 0 ? lns[lns.length  - 1] : 2;
        this.DRG_IDX_MIN = drgs.length > 0 ? drgs[0] : 3;
        this.DRG_IDX_MAX = drgs.length > 0 ? drgs[drgs.length - 1] : 5;

        // 초기 canvas 클래스 설정
        this.canvas.classList.add('cursor-note');

        // renderer postRender 콜백으로 선택 하이라이트 그리기
        this.renderer.postRenderCallback = () => this._drawSelectionHighlights();

        this.bindEvents();
    }

    setMode(mode) {
        this.currentMode = mode;
    }

    setEditorMode(mode) {
        this.editorMode = mode;
        // 편집 모드 관련 상태 전부 초기화
        this.editDrag    = null;
        this.rectSel     = null;
        this.selection   = null;
        this.multiDrag   = null;
        this.canvas.classList.remove('cursor-note', 'cursor-edit', 'cursor-edit-grabbing');
        this.canvas.classList.add(mode === 'edit' ? 'cursor-edit' : 'cursor-note');
        this.renderer.render();
    }

    // ═══════════════════════════════════════════════════════
    //  복사 / 붙여넣기 (Ctrl+C / Ctrl+V)
    // ═══════════════════════════════════════════════════════

    /** 현재 선택 영역을 클립보드에 복사 */
    _copySelection() {
        if (!this.selection || this.selection.notes.length === 0) return;
        this.clipboard = {
            notes: this.selection.notes.map(n => ({ ...n })),
            anchorAbsSlot: this.selection.minAbsSlot,
        };
    }

    /**
     * 클립보드 내용을 붙여넣기.
     * 기준 마디: 현재 뷰포트에서 가장 낮은(바닥에 가까운) 마디.
     * 그 마디가 화면에 20% 미만으로 보이면 한 마디 위(= 번호 +1)를 사용.
     */
    _pasteClipboard() {
        if (!this.clipboard || this.clipboard.notes.length === 0) return;

        const targetMeasure = this._getPasteTargetMeasure();
        const spm = this.noteData.slotsPerMeasure;
        const targetAbsSlot = (targetMeasure - 1) * spm;
        const slotDelta = targetAbsSlot - this.clipboard.anchorAbsSlot;
        const totalSlots = this.noteData.totalMeasures * spm;

        for (const n of this.clipboard.notes) {
            if (n.noteType === 'normal') {
                const newAbs = n.srcAbsSlot + slotDelta;
                if (newAbs < 0 || newAbs >= totalSlots) continue;
                const { measureIndex: m, slotIndex: s } =
                    this.noteData.getMeasureAndSlotFromAbsolute(newAbs);
                this.noteData.setSlot(n.srcLaneName, m, s, '1');

            } else if (n.noteType === 'long') {
                const newStart = n.rangeStart + slotDelta;
                const newEnd   = n.rangeEnd   + slotDelta;
                if (newStart < 0 || newStart >= totalSlots) continue;
                this.noteData.setRange(n.srcLaneName, newStart, Math.min(newEnd, totalSlots - 1), '1');

            } else if (n.noteType === 'drag') {
                const newAbs = n.srcAbsSlot + slotDelta;
                if (newAbs < 0 || newAbs >= totalSlots) continue;
                const { measureIndex: m, slotIndex: s } =
                    this.noteData.getMeasureAndSlotFromAbsolute(newAbs);
                this.noteData.setSlot(n.srcLaneName, m, s, n.value);
            }
        }

        this.renderer.render();
    }

    /**
     * 붙여넣기 기준 마디 계산.
     * 뷰포트 바닥에 가장 가까운 마디를 반환한다.
     * 해당 마디가 20% 미만 노출되면 한 마디 위(번호 +1)를 사용.
     */
    _getPasteTargetMeasure() {
        const rdr   = this.renderer;
        const nd    = this.noteData;
        const slotH = rdr.slotHeight;
        const spm   = nd.slotsPerMeasure;

        // 뷰포트 바닥(Y=height)에 해당하는 절대 슬롯
        const absSlotBottom = rdr.scrollY / slotH;

        // 그 슬롯이 속하는 마디 (1-indexed)
        let targetMeasure = Math.floor(absSlotBottom / spm) + 1;

        // 해당 마디 중 화면에 보이는 비율: targetMeasure의 마지막 슬롯 - absSlotBottom
        const visibleFraction = (targetMeasure * spm - absSlotBottom) / spm;
        if (visibleFraction < 0.2) {
            // 20% 미만만 보이므로 한 마디 위를 사용
            targetMeasure += 1;
        }

        // 마디 시작이 화면에 보이도록 한 마디 위를 기준으로 사용
        targetMeasure += 1;

        return Math.max(1, Math.min(nd.totalMeasures, targetMeasure));
    }


    getSlotInfoFromEvent(evt) {
        const rect = this.canvas.getBoundingClientRect();
        const x = evt.clientX - rect.left;
        const y = evt.clientY - rect.top;

        const laneIdx = this.renderer.getLaneFromX(x);
        const absSlot = this.renderer.getSlotFromY(y);

        let laneName = null;
        if (laneIdx >= 0) {
            laneName = this.renderer.laneNames[laneIdx];
        }

        return { laneName, absSlot, laneIdx, x, y };
    }

    bindEvents() {
        // 스크롤 및 줌
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.player && this.player.isPlaying) {
                const delta = e.deltaY > 0 ? -1 : 1;
                this.player.seekToMeasure(this.player.getCurrentMeasure() + delta);
                return;
            }
            if (e.ctrlKey || e.shiftKey) {
                let delta = e.deltaY > 0 ? -2 : 2;
                this.renderer.setZoom(delta);
            } else {
                this.renderer.scroll(-e.deltaY);
            }
        });

        // ── mousedown ──
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const info = this.getSlotInfoFromEvent(e);

            // ────────────── 편집 모드 ──────────────
            if (this.editorMode === 'edit') {
                this._editModeMouseDown(info);
                return;
            }

            // ────────────── 노트 모드 ──────────────
            if (!info.laneName) return;

            if (info.laneName === 'bpm_change') return;

            if (info.laneName === 'ts_change') {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                if (this.currentMode === 'delete') {
                    this.noteData.removeTsChange(measureIndex, slotIndex);
                } else {
                    const existing = this.noteData.tsChanges.find(
                        c => c.measureIndex === measureIndex && c.slotIndex === slotIndex
                    );
                    if (existing) {
                        this.noteData.removeTsChange(measureIndex, slotIndex);
                    } else {
                        const input = window.prompt('박자 변경 입력 (예: 3/4, 2/4)', '3/4');
                        if (!input) return;
                        const parts = input.trim().split('/');
                        const num = parseInt(parts[0], 10);
                        const den = parseInt(parts[1], 10);
                        if (parts.length !== 2 || isNaN(num) || isNaN(den) || num <= 0 || den <= 0) {
                            alert('올바른 박자 형식이 아닙니다. (예: 3/4)');
                            return;
                        }
                        this.noteData.addTsChange(measureIndex, slotIndex, num, den);
                    }
                }
                this.renderer.render();
                return;
            }

            if (this.currentMode === 'delete') {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                const laneType = info.laneName.split('_')[0];
                if (laneType === 'lane') {
                    const laneNum = info.laneName.split('_')[1];
                    this.noteData.setSlot('normal_' + laneNum, measureIndex, slotIndex, '0');
                    this.noteData.setSlot('long_'   + laneNum, measureIndex, slotIndex, '0');
                } else {
                    this.noteData.setSlot(info.laneName, measureIndex, slotIndex, '0');
                }
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = info.laneName;
                this.renderer.render();
                return;
            }

            const laneType = info.laneName.split('_')[0];
            if (laneType === 'lane') {
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = info.laneName;
                this.dragMoved = false;
            } else if (laneType === 'drag') {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                this.noteData.toggleDragSlot(info.laneName, measureIndex, slotIndex);
                this.renderer.render();
            } else if (laneType === 'long') {
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = info.laneName;
                this.dragMoved = false;
            }
        });

        // ── mousemove ──
        this.canvas.addEventListener('mousemove', (e) => {
            const info = this.getSlotInfoFromEvent(e);

            // 정보 패널 업데이트
            const infoLabel = document.getElementById('mouse-info');
            if (info.laneName && info.absSlot >= 0) {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                infoLabel.innerText = `Lane: ${info.laneName}\nMeasure: #${measureIndex}\nSlot: ${slotIndex}`;
            } else {
                infoLabel.innerText = '-';
            }

            // ────────────── 편집 모드 ──────────────
            if (this.editorMode === 'edit') {
                if (this.editDrag) {
                    this._editModeMouseMove(info);
                } else if (this.multiDrag) {
                    this._updateMultiDrag(info);
                } else if (this.rectSel) {
                    this._updateRectSel(info.x, info.y);
                }
                return;
            }

            // ────────────── 노트 모드 ──────────────
            if (this.isDragging) {
                const dragType = this.dragStartLaneName ? this.dragStartLaneName.split('_')[0] : '';

                if (dragType === 'lane' && this.dragStartLaneName) {
                    if (info.absSlot !== this.dragStartAbsSlot) {
                        this.dragMoved = true;
                        const laneNum = this.dragStartLaneName.split('_')[1];
                        this.noteData.setRange('long_' + laneNum, this.dragStartAbsSlot, info.absSlot, '1');
                        this.renderer.render();
                    }
                }

                if (dragType === 'long' && this.dragStartLaneName) {
                    this.noteData.setRange(this.dragStartLaneName, this.dragStartAbsSlot, info.absSlot, '1');
                    this.renderer.render();
                }

                if (this.currentMode === 'delete' && this.dragStartLaneName) {
                    const delType = this.dragStartLaneName.split('_')[0];
                    if (delType === 'lane') {
                        const laneNum = this.dragStartLaneName.split('_')[1];
                        this.noteData.setRange('normal_' + laneNum, this.dragStartAbsSlot, info.absSlot, '0');
                        this.noteData.setRange('long_'   + laneNum, this.dragStartAbsSlot, info.absSlot, '0');
                    } else {
                        this.noteData.setRange(this.dragStartLaneName, this.dragStartAbsSlot, info.absSlot, '0');
                    }
                    this.renderer.render();
                }
            }
        });

        // ── mouseup ──
        window.addEventListener('mouseup', () => {
            if (this.editorMode === 'edit') {
                if (this.editDrag) {
                    this._editModeMouseUp();
                } else if (this.multiDrag) {
                    this._applyMultiDrag();
                } else if (this.rectSel) {
                    this._finishRectSel();
                }
                return;
            }

            // 노트 모드 드래그 종료
            if (this.isDragging) {
                const dragType = this.dragStartLaneName ? this.dragStartLaneName.split('_')[0] : '';
                if (dragType === 'lane' && !this.dragMoved && this.currentMode !== 'delete') {
                    const laneNum = this.dragStartLaneName.split('_')[1];
                    const longLane = 'long_' + laneNum;
                    const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(this.dragStartAbsSlot);
                    const mData = this.noteData.getMeasureData(longLane, measureIndex);
                    if (mData && mData[slotIndex] === '1') {
                        const { rangeStart, rangeEnd } = this._getLongNoteRange(longLane, this.dragStartAbsSlot);
                        this.noteData.setRange(longLane, rangeStart, rangeEnd, '0');
                    } else {
                        this.noteData.toggleSlot('normal_' + laneNum, measureIndex, slotIndex);
                    }
                }
                this.isDragging = false;
                this.dragMoved = false;
                this.renderer.render();
            }
        });

        // ── Ctrl+C / Ctrl+V ──
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'c') {
                this._copySelection();
            } else if (e.ctrlKey && e.key === 'v') {
                this._pasteClipboard();
            }
        });
    }

    // ═══════════════════════════════════════════════════════
    //  편집 모드 - 단일 노트 드래그 (기존 동작)
    // ═══════════════════════════════════════════════════════

    _editModeMouseDown(info) {
        // 활성 선택 영역이 있으면 → 내부 클릭 시 다중 이동 시작, 외부 클릭 시 선택 해제
        if (this.selection && this.selection.notes.length > 0) {
            if (info.laneIdx >= 0 && this._isInSelectionBounds(info)) {
                this._startMultiDrag(info);
                return;
            }
            // 선택 영역 밖 클릭 → 선택 해제
            this.selection = null;
            this.renderer.render();
        }

        if (!info.laneName) return;
        if (info.laneName === 'bpm_change' || info.laneName === 'ts_change') return;

        // 단일 노트 드래그 시도
        if (this._tryStartSingleNoteDrag(info)) return;

        // 빈 공간 클릭 → 범위 선택 시작
        this._startRectSel(info.x, info.y);
    }

    /** 노트 위에서 클릭 시 단일 드래그 시작. 노트가 있으면 true 반환 */
    _tryStartSingleNoteDrag(info) {
        const laneType = info.laneName.split('_')[0];
        const laneNum  = info.laneName.split('_')[1];
        const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);

        if (laneType === 'lane') {
            const normalLane = 'normal_' + laneNum;
            const longLane   = 'long_'   + laneNum;
            const normalData = this.noteData.getMeasureData(normalLane, measureIndex);
            const longData   = this.noteData.getMeasureData(longLane,   measureIndex);

            if (normalData && normalData[slotIndex] === '1') {
                this.editDrag = {
                    noteType: 'normal', srcLaneName: normalLane,
                    srcLaneNum: laneNum, srcLaneIdx: info.laneIdx, srcAbsSlot: info.absSlot,
                };
                this.editDragCurAbsSlot = info.absSlot;
                this.editDragCurLaneIdx = info.laneIdx;
                this._setEditCursor(true);
                return true;
            } else if (longData && longData[slotIndex] === '1') {
                const { rangeStart, rangeEnd } = this._getLongNoteRange(longLane, info.absSlot);
                this.editDrag = {
                    noteType: 'long', srcLaneName: longLane,
                    srcLaneNum: laneNum, srcLaneIdx: info.laneIdx, srcAbsSlot: info.absSlot,
                    rangeStart, rangeEnd,
                };
                this.editDragCurAbsSlot = info.absSlot;
                this.editDragCurLaneIdx = info.laneIdx;
                this._setEditCursor(true);
                return true;
            }
        } else if (laneType === 'drag') {
            const dragData = this.noteData.getMeasureData(info.laneName, measureIndex);
            const val = dragData ? dragData[slotIndex] : '0';
            if (val === '1' || val === '2') {
                this.editDrag = {
                    noteType: 'drag', srcLaneName: info.laneName,
                    srcLaneNum: laneNum, srcLaneIdx: info.laneIdx, srcAbsSlot: info.absSlot,
                    value: val,
                };
                this.editDragCurAbsSlot = info.absSlot;
                this.editDragCurLaneIdx = info.laneIdx;
                this._setEditCursor(true);
                return true;
            }
        }
        return false;
    }

    /** mousemove 처리: 단일 노트 드래그 중 ghost 표시 */
    _editModeMouseMove(info) {
        const drag = this.editDrag;

        if (info.laneIdx >= 0 && info.laneName) {
            const targetType = info.laneName.split('_')[0];
            // 일반/롱/드래그 노트 모두 lane ↔ drag 간 이동 허용
            if (targetType === 'lane' || targetType === 'drag') {
                this.editDragCurLaneIdx = info.laneIdx;
            }
        }

        // 다른 레인 이동 시 타이밍 유지
        if (this.editDragCurLaneIdx !== drag.srcLaneIdx) {
            this.editDragCurAbsSlot = drag.srcAbsSlot;
        } else if (info.absSlot >= 0) {
            this.editDragCurAbsSlot = info.absSlot;
        }

        this.renderer.render();
        this._drawEditGhost();
    }

    /** mouseup 처리: 단일 노트 이동 확정 */
    _editModeMouseUp() {
        const drag = this.editDrag;
        const newAbsSlot = this.editDragCurAbsSlot;
        const newLaneIdx = this.editDragCurLaneIdx;
        const moved = (newAbsSlot !== drag.srcAbsSlot) || (newLaneIdx !== drag.srcLaneIdx);

        if (moved) {
            const newLaneName = this.renderer.laneNames[newLaneIdx];
            const newLaneNum  = newLaneName ? newLaneName.split('_')[1] : drag.srcLaneNum;
            const targetIsDrag = newLaneName && newLaneName.startsWith('drag_');
            const targetIsLane = newLaneName && newLaneName.startsWith('lane_');

            if (drag.noteType === 'normal') {
                const { measureIndex: oldM, slotIndex: oldS } =
                    this.noteData.getMeasureAndSlotFromAbsolute(drag.srcAbsSlot);
                this.noteData.setSlot(drag.srcLaneName, oldM, oldS, '0');
                const { measureIndex: newM, slotIndex: newS } =
                    this.noteData.getMeasureAndSlotFromAbsolute(newAbsSlot);
                if (targetIsDrag) {
                    // 일반 노트 → 드래그 레인: 드래그 노트 '1' 로 배치
                    this.noteData.setSlot('drag_' + newLaneNum, newM, newS, '1');
                } else {
                    this.noteData.setSlot('normal_' + newLaneNum, newM, newS, '1');
                }

            } else if (drag.noteType === 'long') {
                if (targetIsDrag) {
                    // 롱노트 → 드래그 레인: 경고 후 삭제만 수행
                    const ok = window.confirm(
                        '롱노트를 드래그 레인으로 이동할 수 없습니다.\n' +
                        '해당 롱노트는 삭제됩니다.\n' +
                        '계속하시겠습니까?'
                    );
                    if (ok) {
                        this.noteData.setRange(drag.srcLaneName, drag.rangeStart, drag.rangeEnd, '0');
                    }
                    // cancel 시 noteData 변경 없이 상태만 초기화
                } else {
                    const delta    = newAbsSlot - drag.srcAbsSlot;
                    const newStart = drag.rangeStart + delta;
                    const newEnd   = drag.rangeEnd   + delta;
                    this.noteData.setRange(drag.srcLaneName, drag.rangeStart, drag.rangeEnd, '0');
                    if (newStart >= 0) {
                        this.noteData.setRange('long_' + newLaneNum, newStart, newEnd, '1');
                    }
                }

            } else if (drag.noteType === 'drag') {
                const { measureIndex: oldM, slotIndex: oldS } =
                    this.noteData.getMeasureAndSlotFromAbsolute(drag.srcAbsSlot);
                this.noteData.setSlot(drag.srcLaneName, oldM, oldS, '0');
                const { measureIndex: newM, slotIndex: newS } =
                    this.noteData.getMeasureAndSlotFromAbsolute(newAbsSlot);
                if (targetIsLane) {
                    // 드래그 노트 → 일반 레인: 일반 노트 '1' 로 배치
                    this.noteData.setSlot('normal_' + newLaneNum, newM, newS, '1');
                } else {
                    this.noteData.setSlot('drag_' + newLaneNum, newM, newS, drag.value);
                }
            }
        }

        this.editDrag = null;
        this.editDragCurAbsSlot = -1;
        this.editDragCurLaneIdx = -1;
        this._setEditCursor(false);
        this.renderer.render();
    }

    // ═══════════════════════════════════════════════════════
    //  편집 모드 - 범위 선택 (rect selection)
    // ═══════════════════════════════════════════════════════

    _startRectSel(x, y) {
        this.rectSel = { startX: x, startY: y, curX: x, curY: y };
    }

    _updateRectSel(x, y) {
        this.rectSel.curX = x;
        this.rectSel.curY = y;
        this.renderer.render();
        this._drawRectSelBox();
    }

    _finishRectSel() {
        const sel = this.rectSel;
        this.rectSel = null;
        if (!sel) { this.renderer.render(); return; }

        const minX = Math.min(sel.startX, sel.curX);
        const maxX = Math.max(sel.startX, sel.curX);
        const minY = Math.min(sel.startY, sel.curY);
        const maxY = Math.max(sel.startY, sel.curY);

        // 최소 드래그 크기 미만은 무시
        if (maxX - minX < this.MIN_RECT_SEL_SIZE && maxY - minY < this.MIN_RECT_SEL_SIZE) {
            this.renderer.render();
            return;
        }

        const notes = this._collectNotesInRect(minX, maxX, minY, maxY);

        if (notes.length > 0) {
            let minLaneIdx = Infinity, maxLaneIdx = -Infinity;
            let minAbsSlot = Infinity, maxAbsSlot = -Infinity;
            for (const n of notes) {
                minLaneIdx = Math.min(minLaneIdx, n.srcLaneIdx);
                maxLaneIdx = Math.max(maxLaneIdx, n.srcLaneIdx);
                const s0 = n.noteType === 'long' ? n.rangeStart : n.srcAbsSlot;
                const s1 = n.noteType === 'long' ? n.rangeEnd   : n.srcAbsSlot;
                minAbsSlot = Math.min(minAbsSlot, s0);
                maxAbsSlot = Math.max(maxAbsSlot, s1);
            }
            this.selection = { notes, minLaneIdx, maxLaneIdx, minAbsSlot, maxAbsSlot };
        }

        this.renderer.render();
    }

    /**
     * 픽셀 사각형 내의 노트를 수집하여 반환.
     * - Ln열: normal_N(일반 노트) + long_N(롱노트 범위)
     * - Drg열: drag_N
     */
    _collectNotesInRect(minX, maxX, minY, maxY) {
        const rdr  = this.renderer;
        const nd   = this.noteData;
        const gridStartX = rdr.getGridStartX();
        const laneW  = rdr.laneWidth;
        const slotH  = rdr.slotHeight;
        const h      = rdr.height;
        const scroll = rdr.scrollY;
        const spm    = nd.slotsPerMeasure;

        // Y 픽셀 → absSlot 범위 (비스냅)
        // noteY = h - absSlot*slotH + scroll  →  absSlot = (h - noteY + scroll) / slotH
        const absSlotMin = (h - maxY + scroll) / slotH;
        const absSlotMax = (h - minY + scroll) / slotH;

        // X 픽셀 → laneIdx 범위
        const relMinX   = minX - gridStartX;
        const relMaxX   = maxX - gridStartX;
        const laneIdxMin = Math.max(0, Math.floor(relMinX / laneW));
        const laneIdxMax = Math.min(rdr.laneNames.length - 1, Math.floor(relMaxX / laneW));

        // 마디 범위 (여유분 포함)
        const mStart = Math.max(1, Math.floor(absSlotMin / spm));
        const mEnd   = Math.min(nd.totalMeasures, Math.ceil(absSlotMax / spm) + 1);

        const notes = [];

        for (let li = laneIdxMin; li <= laneIdxMax; li++) {
            const laneName = rdr.laneNames[li];
            if (!laneName || laneName === 'bpm_change' || laneName === 'ts_change') continue;

            const laneType = laneName.split('_')[0];
            const laneNum  = laneName.split('_')[1];

            if (laneType === 'lane') {
                const normalLane = 'normal_' + laneNum;
                const longLane   = 'long_'   + laneNum;

                // 일반 노트
                for (let m = mStart; m <= mEnd; m++) {
                    const d = nd.lanes[normalLane][m];
                    if (!d) continue;
                    for (let s = 0; s < d.length; s++) {
                        if (d[s] !== '1') continue;
                        const absSlot = nd.getAbsoluteSlotIndex(m, s);
                        if (absSlot >= absSlotMin && absSlot <= absSlotMax) {
                            notes.push({
                                noteType: 'normal', srcLaneName: normalLane,
                                srcLaneNum: laneNum, srcLaneIdx: li, srcAbsSlot: absSlot,
                            });
                        }
                    }
                }

                // 롱노트 (Y 범위에 걸치는 범위 전체 선택)
                const visitedLong = new Set();
                for (let m = mStart; m <= mEnd; m++) {
                    const d = nd.lanes[longLane][m];
                    if (!d) continue;
                    for (let s = 0; s < d.length; s++) {
                        if (d[s] !== '1') continue;
                        const absSlot = nd.getAbsoluteSlotIndex(m, s);
                        if (absSlot < absSlotMin || absSlot > absSlotMax) continue;
                        const { rangeStart, rangeEnd } = this._getLongNoteRange(longLane, absSlot);
                        const key = `${rangeStart}-${rangeEnd}`;
                        if (!visitedLong.has(key)) {
                            visitedLong.add(key);
                            notes.push({
                                noteType: 'long', srcLaneName: longLane,
                                srcLaneNum: laneNum, srcLaneIdx: li,
                                srcAbsSlot: rangeStart, rangeStart, rangeEnd,
                            });
                        }
                    }
                }

            } else if (laneType === 'drag') {
                for (let m = mStart; m <= mEnd; m++) {
                    const d = nd.lanes[laneName][m];
                    if (!d) continue;
                    for (let s = 0; s < d.length; s++) {
                        if (d[s] !== '1' && d[s] !== '2') continue;
                        const absSlot = nd.getAbsoluteSlotIndex(m, s);
                        if (absSlot >= absSlotMin && absSlot <= absSlotMax) {
                            notes.push({
                                noteType: 'drag', srcLaneName: laneName,
                                srcLaneNum: laneNum, srcLaneIdx: li,
                                srcAbsSlot: absSlot, value: d[s],
                            });
                        }
                    }
                }
            }
        }

        return notes;
    }

    // ═══════════════════════════════════════════════════════
    //  편집 모드 - 다중 노트 이동 (multi-drag)
    // ═══════════════════════════════════════════════════════

    /** 선택 영역이 현재 마우스 위치를 포함하는지 (픽셀 기준, scroll/zoom 반응) */
    _isInSelectionBounds(info) {
        const sel = this.selection;
        if (!sel || !sel.notes || sel.notes.length === 0) return false;

        const gridStartX = this.renderer.getGridStartX();
        const laneW = this.renderer.laneWidth;
        const PAD   = this.SELECTION_HIT_PADDING;

        let pxMinX = Infinity, pxMaxX = -Infinity;
        let pxMinY = Infinity, pxMaxY = -Infinity;
        const ch = this._noteBarHeight();

        for (const n of sel.notes) {
            const lx = gridStartX + n.srcLaneIdx * laneW;
            pxMinX = Math.min(pxMinX, lx);
            pxMaxX = Math.max(pxMaxX, lx + laneW);

            if (n.noteType === 'long') {
                const { measureIndex: m1, slotIndex: s1 } =
                    this.noteData.getMeasureAndSlotFromAbsolute(n.rangeStart);
                const { measureIndex: m2, slotIndex: s2 } =
                    this.noteData.getMeasureAndSlotFromAbsolute(n.rangeEnd);
                const y1 = this.renderer.getY(m1, s1);
                const y2 = this.renderer.getY(m2, s2);
                pxMinY = Math.min(pxMinY, Math.min(y1, y2));
                pxMaxY = Math.max(pxMaxY, Math.max(y1, y2));
            } else {
                const { measureIndex, slotIndex } =
                    this.noteData.getMeasureAndSlotFromAbsolute(n.srcAbsSlot);
                const ny = this.renderer.getY(measureIndex, slotIndex);
                pxMinY = Math.min(pxMinY, ny - ch / 2);
                pxMaxY = Math.max(pxMaxY, ny + ch / 2);
            }
        }

        return info.x >= pxMinX - PAD && info.x <= pxMaxX + PAD &&
               info.y >= pxMinY - PAD && info.y <= pxMaxY + PAD;
    }

    _startMultiDrag(info) {
        this.multiDrag = {
            anchorLaneIdx: info.laneIdx,
            anchorAbsSlot: info.absSlot,
            curLaneIdx:    info.laneIdx,
            curAbsSlot:    info.absSlot,
        };
        this._setEditCursor(true);
    }

    _updateMultiDrag(info) {
        if (info.laneIdx >= 0) this.multiDrag.curLaneIdx = info.laneIdx;
        if (info.absSlot >= 0) this.multiDrag.curAbsSlot = info.absSlot;
        this.renderer.render();
        this._drawMultiDragGhosts();
    }

    /**
     * 다중 이동 확정.
     * 1) 모든 노트의 목적지를 먼저 계산한다.
     * 2) 하나라도 레인 범위를 벗어나면 confirm 팝업을 띄운다.
     * 3) 확인 시: 범위 내 이동 가능한 노트만 이동한다 (범위 벗어난 노트는 그대로 유지).
     *    취소 시: 아무 노트도 이동하지 않는다.
     */
    _applyMultiDrag() {
        const md  = this.multiDrag;
        const sel = this.selection;
        this.multiDrag = null;
        this._setEditCursor(false);

        if (!md || !sel || sel.notes.length === 0) {
            this.renderer.render();
            return;
        }

        const laneDelta = md.curLaneIdx - md.anchorLaneIdx;
        const slotDelta = laneDelta === 0 ? (md.curAbsSlot - md.anchorAbsSlot) : 0;

        if (laneDelta === 0 && slotDelta === 0) {
            this.renderer.render();
            return;
        }

        // ── 1단계: 모든 노트의 이동 가능 여부 사전 확인 ──
        let anyOverflow = false;
        let anyLongToDrag = false;
        for (const n of sel.notes) {
            const newLaneIdx = n.srcLaneIdx + laneDelta;
            // 전체 노트 레인 범위 (0 ~ DRG_IDX_MAX) 벗어나면 overflow
            if (newLaneIdx < 0 || newLaneIdx > this.DRG_IDX_MAX) {
                anyOverflow = true;
            } else {
                const targetLane = this.renderer.laneNames[newLaneIdx];
                if (n.noteType === 'long' && targetLane && targetLane.startsWith('drag_')) {
                    anyLongToDrag = true;
                }
            }
        }

        // ── 2단계: 문제가 있는 경우 확인 팝업 ──
        if (anyOverflow || anyLongToDrag) {
            const msgs = [];
            if (anyOverflow)    msgs.push('범위를 벗어난 노트는 삭제됩니다.');
            if (anyLongToDrag)  msgs.push('롱노트를 드래그 레인으로 이동할 수 없어 삭제됩니다.');
            const ok = window.confirm(msgs.join('\n') + '\n계속하시겠습니까?');
            if (!ok) {
                // 취소 → 아무것도 이동하지 않음, 선택 유지
                this.renderer.render();
                return;
            }
        }

        // ── 3단계: 이동 가능한 노트 목록 확정 (overflow 및 long→drag 제외) ──
        const movable = sel.notes.filter(n => {
            const newLaneIdx = n.srcLaneIdx + laneDelta;
            if (newLaneIdx < 0 || newLaneIdx > this.DRG_IDX_MAX) return false;
            const targetLane = this.renderer.laneNames[newLaneIdx];
            if (n.noteType === 'long' && targetLane && targetLane.startsWith('drag_')) return false;
            return true;
        });

        // ── 4단계: 선택된 모든 노트 삭제 (범위 초과 포함) → 이동 가능 노트만 새 위치에 배치 ──

        // 전체 삭제 먼저 (이동 충돌 방지, 범위 초과 노트도 함께 삭제)
        for (const n of sel.notes) {
            if (n.noteType === 'normal') {
                const { measureIndex: m, slotIndex: s } =
                    this.noteData.getMeasureAndSlotFromAbsolute(n.srcAbsSlot);
                this.noteData.setSlot(n.srcLaneName, m, s, '0');
            } else if (n.noteType === 'long') {
                this.noteData.setRange(n.srcLaneName, n.rangeStart, n.rangeEnd, '0');
            } else if (n.noteType === 'drag') {
                const { measureIndex: m, slotIndex: s } =
                    this.noteData.getMeasureAndSlotFromAbsolute(n.srcAbsSlot);
                this.noteData.setSlot(n.srcLaneName, m, s, '0');
            }
        }

        // 새 위치 배치 (이동 가능한 노트만, 타입 변환 포함)
        for (const n of movable) {
            const newLaneIdx  = n.srcLaneIdx + laneDelta;
            const newRendLane = this.renderer.laneNames[newLaneIdx]; // 'lane_N' or 'drag_N'
            const newLaneNum  = newRendLane.split('_')[1];
            const targetIsDrag = newRendLane.startsWith('drag_');
            const targetIsLane = newRendLane.startsWith('lane_');

            if (n.noteType === 'normal') {
                const newAbsSlot = Math.max(0, n.srcAbsSlot + slotDelta);
                const { measureIndex: m, slotIndex: s } =
                    this.noteData.getMeasureAndSlotFromAbsolute(newAbsSlot);
                if (targetIsDrag) {
                    this.noteData.setSlot('drag_' + newLaneNum, m, s, '1');
                } else {
                    this.noteData.setSlot('normal_' + newLaneNum, m, s, '1');
                }
            } else if (n.noteType === 'long') {
                // long→drag は movable から除外済みなので必ずlane行き
                const newStart = n.rangeStart + slotDelta;
                const newEnd   = n.rangeEnd   + slotDelta;
                if (newStart >= 0) {
                    this.noteData.setRange('long_' + newLaneNum, newStart, newEnd, '1');
                }
            } else if (n.noteType === 'drag') {
                const newAbsSlot = Math.max(0, n.srcAbsSlot + slotDelta);
                const { measureIndex: m, slotIndex: s } =
                    this.noteData.getMeasureAndSlotFromAbsolute(newAbsSlot);
                if (targetIsLane) {
                    this.noteData.setSlot('normal_' + newLaneNum, m, s, '1');
                } else {
                    this.noteData.setSlot('drag_' + newLaneNum, m, s, n.value);
                }
            }
        }

        this.selection = null;
        this.renderer.render();
    }

    // ═══════════════════════════════════════════════════════
    //  편집 모드 - 그리기 (오버레이)
    // ═══════════════════════════════════════════════════════

    /** 범위 선택 사각형 그리기 */
    _drawRectSelBox() {
        const sel = this.rectSel;
        if (!sel) return;

        const ctx = this.renderer.ctx;
        const dpr = this.renderer.dpr;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const x = Math.min(sel.startX, sel.curX);
        const y = Math.min(sel.startY, sel.curY);
        const w = Math.abs(sel.curX - sel.startX);
        const h = Math.abs(sel.curY - sel.startY);

        ctx.fillStyle   = 'rgba(100,200,255,0.10)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(100,200,255,0.90)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        ctx.restore();
    }

    /** 선택된 노트 하이라이트 (postRenderCallback에서 호출) */
    _drawSelectionHighlights() {
        const sel = this.selection;
        if (!sel || !sel.notes || sel.notes.length === 0) return;

        const ctx = this.renderer.ctx;
        const dpr = this.renderer.dpr;
        const laneW = this.renderer.laneWidth;
        const gridStartX = this.renderer.getGridStartX();

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        for (const n of sel.notes) {
            const lx = gridStartX + n.srcLaneIdx * laneW;
            if (n.noteType === 'long') {
                this._ghostOutlineLong(ctx, lx, n.rangeStart, n.rangeEnd, laneW, 'rgba(100,200,255,0.9)');
            } else {
                this._ghostOutlineNormal(ctx, lx, n.srcAbsSlot, laneW, 'rgba(100,200,255,0.9)');
            }
        }

        ctx.restore();
    }

    /** 단일 노트 드래그 ghost 그리기 */
    _drawEditGhost() {
        const drag = this.editDrag;
        if (!drag) return;

        const ctx  = this.renderer.ctx;
        const dpr  = this.renderer.dpr;
        const laneW = this.renderer.laneWidth;
        const gridStartX = this.renderer.getGridStartX();

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const srcX = gridStartX + drag.srcLaneIdx * laneW;
        if (drag.noteType === 'normal') {
            this._ghostDimNormal(ctx, srcX, drag.srcAbsSlot, laneW, 'rgba(0,0,0,0.55)');
        } else if (drag.noteType === 'long') {
            this._ghostDimLong(ctx, srcX, drag.rangeStart, drag.rangeEnd, laneW, 'rgba(0,0,0,0.55)');
        } else {
            this._ghostDimNormal(ctx, srcX, drag.srcAbsSlot, laneW, 'rgba(0,0,0,0.55)');
        }

        const dstX = gridStartX + this.editDragCurLaneIdx * laneW;
        const dstRendLane = this.renderer.laneNames[this.editDragCurLaneIdx];
        const dstIsDrag = dstRendLane && dstRendLane.startsWith('drag_');
        const dstIsLane = dstRendLane && dstRendLane.startsWith('lane_');

        if (drag.noteType === 'normal') {
            if (dstIsDrag) {
                // 일반 노트 → 드래그 레인: 드래그 노트 색으로 표시
                this._ghostDimNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,145,0,0.55)');
                this._ghostOutlineNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,145,0,1)');
            } else {
                this._ghostDimNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,51,102,0.55)');
                this._ghostOutlineNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,51,102,1)');
            }
        } else if (drag.noteType === 'long') {
            if (dstIsDrag) {
                // 롱노트 → 드래그 레인: 삭제 경고 (빨간 tint)
                this._ghostDimLong(ctx, srcX, drag.rangeStart, drag.rangeEnd, laneW, 'rgba(255,60,60,0.45)');
                this._ghostDimNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,60,60,0.4)');
                this._ghostOutlineNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,60,60,1)');
            } else {
                const delta    = this.editDragCurAbsSlot - drag.srcAbsSlot;
                const newStart = drag.rangeStart + delta;
                const newEnd   = drag.rangeEnd   + delta;
                this._ghostDimLong(ctx, dstX, newStart, newEnd, laneW, 'rgba(0,230,118,0.45)');
                this._ghostOutlineLong(ctx, dstX, newStart, newEnd, laneW, 'rgba(0,230,118,1)');
            }
        } else {
            if (dstIsLane) {
                // 드래그 노트 → 일반 레인: 일반 노트 색으로 표시
                this._ghostDimNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,51,102,0.55)');
                this._ghostOutlineNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,51,102,1)');
            } else {
                const ghostColor   = drag.value === '2' ? 'rgba(255,34,34,0.55)' : 'rgba(255,204,0,0.55)';
                const outlineColor = drag.value === '2' ? 'rgba(255,34,34,1)'    : 'rgba(255,204,0,1)';
                this._ghostDimNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, ghostColor);
                this._ghostOutlineNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, outlineColor);
            }
        }

        ctx.restore();
    }

    /** 다중 노트 이동 ghost 그리기 */
    _drawMultiDragGhosts() {
        const md  = this.multiDrag;
        const sel = this.selection;
        if (!md || !sel) return;

        const ctx = this.renderer.ctx;
        const dpr = this.renderer.dpr;
        const laneW = this.renderer.laneWidth;
        const gridStartX = this.renderer.getGridStartX();

        const laneDelta = md.curLaneIdx - md.anchorLaneIdx;
        const slotDelta = laneDelta === 0 ? (md.curAbsSlot - md.anchorAbsSlot) : 0;

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        for (const n of sel.notes) {
            const srcX = gridStartX + n.srcLaneIdx * laneW;
            const newLaneIdx = n.srcLaneIdx + laneDelta;

            const targetRendLane = (newLaneIdx >= 0 && newLaneIdx <= this.DRG_IDX_MAX)
                ? this.renderer.laneNames[newLaneIdx] : null;
            const overflow    = !targetRendLane || newLaneIdx < 0 || newLaneIdx > this.DRG_IDX_MAX;
            const longToDrag  = !overflow && n.noteType === 'long' &&
                                targetRendLane.startsWith('drag_');
            const willDelete  = overflow || longToDrag;

            // 원래 위치 어둡게
            if (n.noteType === 'long') {
                this._ghostDimLong(ctx, srcX, n.rangeStart, n.rangeEnd, laneW, 'rgba(0,0,0,0.55)');
            } else {
                this._ghostDimNormal(ctx, srcX, n.srcAbsSlot, laneW, 'rgba(0,0,0,0.55)');
            }

            if (!willDelete) {
                const dstX = gridStartX + newLaneIdx * laneW;
                const tgtIsDrag = targetRendLane.startsWith('drag_');
                const tgtIsLane = targetRendLane.startsWith('lane_');

                if (n.noteType === 'normal') {
                    const na = n.srcAbsSlot + slotDelta;
                    if (tgtIsDrag) {
                        this._ghostDimNormal(ctx, dstX, na, laneW, 'rgba(255,145,0,0.50)');
                        this._ghostOutlineNormal(ctx, dstX, na, laneW, 'rgba(255,145,0,1)');
                    } else {
                        this._ghostDimNormal(ctx, dstX, na, laneW, 'rgba(255,51,102,0.50)');
                        this._ghostOutlineNormal(ctx, dstX, na, laneW, 'rgba(255,51,102,1)');
                    }
                } else if (n.noteType === 'long') {
                    const ns = n.rangeStart + slotDelta;
                    const ne = n.rangeEnd   + slotDelta;
                    this._ghostDimLong(ctx, dstX, ns, ne, laneW, 'rgba(0,230,118,0.45)');
                    this._ghostOutlineLong(ctx, dstX, ns, ne, laneW, 'rgba(0,230,118,1)');
                } else {
                    const na = n.srcAbsSlot + slotDelta;
                    if (tgtIsLane) {
                        this._ghostDimNormal(ctx, dstX, na, laneW, 'rgba(255,51,102,0.50)');
                        this._ghostOutlineNormal(ctx, dstX, na, laneW, 'rgba(255,51,102,1)');
                    } else {
                        const gc = n.value === '2' ? 'rgba(255,34,34,0.50)' : 'rgba(255,204,0,0.50)';
                        const oc = n.value === '2' ? 'rgba(255,34,34,1)'    : 'rgba(255,204,0,1)';
                        this._ghostDimNormal(ctx, dstX, na, laneW, gc);
                        this._ghostOutlineNormal(ctx, dstX, na, laneW, oc);
                    }
                }
            } else {
                // 삭제 대상: 원래 위치에 빨간 경고 tint
                if (n.noteType === 'long') {
                    this._ghostDimLong(ctx, srcX, n.rangeStart, n.rangeEnd, laneW, 'rgba(255,60,60,0.45)');
                } else {
                    this._ghostDimNormal(ctx, srcX, n.srcAbsSlot, laneW, 'rgba(255,60,60,0.45)');
                }
            }
        }

        ctx.restore();
    }

    // ═══════════════════════════════════════════════════════
    //  ghost 헬퍼
    // ═══════════════════════════════════════════════════════

    _noteBarHeight() {
        return Math.max(this.NOTE_MIN_HEIGHT, this.renderer.slotHeight * this.NOTE_HEIGHT_RATIO);
    }

    _ghostDimNormal(ctx, laneX, absSlot, laneW, fillStyle) {
        const total = this.noteData.totalMeasures * this.noteData.slotsPerMeasure;
        if (absSlot < 0 || absSlot >= total) return;
        const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlot);
        const noteY = this.renderer.getY(measureIndex, slotIndex);
        const ch = this._noteBarHeight();
        ctx.fillStyle = fillStyle;
        ctx.fillRect(laneX + 3, noteY - ch / 2, laneW - 6, ch);
    }

    _ghostOutlineNormal(ctx, laneX, absSlot, laneW, strokeStyle) {
        const total = this.noteData.totalMeasures * this.noteData.slotsPerMeasure;
        if (absSlot < 0 || absSlot >= total) return;
        const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlot);
        const noteY = this.renderer.getY(measureIndex, slotIndex);
        const ch = this._noteBarHeight();
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(laneX + 3, noteY - ch / 2, laneW - 6, ch);
    }

    _ghostDimLong(ctx, laneX, absStart, absEnd, laneW, fillStyle) {
        const total = this.noteData.totalMeasures * this.noteData.slotsPerMeasure;
        const start = Math.max(0, Math.min(absStart, absEnd));
        const end   = Math.min(total - 1, Math.max(absStart, absEnd));
        if (start >= total || end < 0) return;
        const { measureIndex: m1, slotIndex: s1 } = this.noteData.getMeasureAndSlotFromAbsolute(start);
        const { measureIndex: m2, slotIndex: s2 } = this.noteData.getMeasureAndSlotFromAbsolute(end);
        const y1 = this.renderer.getY(m1, s1);
        const y2 = this.renderer.getY(m2, s2);
        const topY = Math.min(y1, y2);
        const h    = Math.max(Math.abs(y1 - y2), 4);
        ctx.fillStyle = fillStyle;
        ctx.fillRect(laneX + 5, topY, laneW - 10, h);
    }

    _ghostOutlineLong(ctx, laneX, absStart, absEnd, laneW, strokeStyle) {
        const total = this.noteData.totalMeasures * this.noteData.slotsPerMeasure;
        const start = Math.max(0, Math.min(absStart, absEnd));
        const end   = Math.min(total - 1, Math.max(absStart, absEnd));
        if (start >= total || end < 0) return;
        const { measureIndex: m1, slotIndex: s1 } = this.noteData.getMeasureAndSlotFromAbsolute(start);
        const { measureIndex: m2, slotIndex: s2 } = this.noteData.getMeasureAndSlotFromAbsolute(end);
        const y1 = this.renderer.getY(m1, s1);
        const y2 = this.renderer.getY(m2, s2);
        const topY = Math.min(y1, y2);
        const h    = Math.max(Math.abs(y1 - y2), 4);
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(laneX + 5, topY, laneW - 10, h);
    }

    _setEditCursor(grabbing) {
        this.canvas.classList.remove('cursor-edit', 'cursor-edit-grabbing');
        this.canvas.classList.add(grabbing ? 'cursor-edit-grabbing' : 'cursor-edit');
    }

    // ═══════════════════════════════════════════════════════
    //  공통 헬퍼
    // ═══════════════════════════════════════════════════════

    _getLongNoteRange(longLaneName, absSlot) {
        const totalSlots = this.noteData.totalMeasures * this.noteData.slotsPerMeasure;
        const getVal = (i) => {
            if (i < 0 || i >= totalSlots) return '0';
            const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(i);
            const d = this.noteData.getMeasureData(longLaneName, measureIndex);
            return d ? d[slotIndex] : '0';
        };

        let start = absSlot;
        while (start > 0 && getVal(start - 1) === '1') start--;
        let end = absSlot;
        while (end < totalSlots - 1 && getVal(end + 1) === '1') end++;

        return { rangeStart: start, rangeEnd: end };
    }
}
