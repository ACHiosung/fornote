/**
 * Exporter - 데이터를 TXT / JSON 파일로 생성 및 다운로드 처리
 */

class Exporter {
    constructor(noteData) {
        this.noteData = noteData;
    }

    downloadTXT() {
        const text = this.noteData.exportToTXT();
        
        // Blob 생성
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        
        // 다운로드 링크 생성 및 클릭
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `beatmap_${timestamp}.txt`;
        document.body.appendChild(a);
        a.click();
        
        // 클린업
        setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 0);
    }

    downloadJSON() {
        const json = this._buildJSON();
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `beatmap_${timestamp}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 0);
    }

    /**
     * 노트 데이터를 sample/notes.json 포맷의 JSON 문자열로 변환합니다.
     *
     * 타입 규칙 (sample 포맷 기준):
     *   type  0 = 일반 노트  (normal_N 레인, 에디터 값 '1')
     *   type  1 = 롱 노트    (long_N 레인, 연속된 '1' 구간)
     *   type  2 = 드래그 노트 (drag_N 레인, '1'=중간 / '2'=끝 빨간 노트)
     *   type -1 = 곡 끝 마커 (마지막 노트 이후 1마디)
     *
     * 레인 → position 매핑:
     *   lane 1 (좌) → { x: -5, y: -2 }
     *   lane 2 (중) → { x:  0, y: -2 }
     *   lane 3 (우) → { x:  5, y: -2 }
     */
    _buildJSON() {
        const nd = this.noteData;
        const spm = nd.slotsPerMeasure;
        const num = nd.timeSignature.numerator;

        // ── BPM 타임라인: [{absSlot, bpm}, ...] 오름차순 정렬 ──
        const bpmTimeline = [{ absSlot: 0, bpm: nd.bpm }];
        for (const c of nd.bpmChanges) {
            bpmTimeline.push({
                absSlot: nd.getAbsoluteSlotIndex(c.measureIndex, c.slotIndex),
                bpm: c.bpm,
            });
        }
        bpmTimeline.sort((a, b) => a.absSlot - b.absSlot);

        // 절대 슬롯 인덱스 → 초(second) 변환 (BPM 변화 고려)
        const getTime = (absSlot) => {
            let time = 0, prevSlot = 0, curBpm = nd.bpm;
            for (const ev of bpmTimeline) {
                if (ev.absSlot >= absSlot) break;
                time += (ev.absSlot - prevSlot) * (60 / curBpm * num / spm);
                prevSlot = ev.absSlot;
                curBpm = ev.bpm;
            }
            return time + (absSlot - prevSlot) * (60 / curBpm * num / spm);
        };

        // 레인 번호 → 게임 좌표
        const lanePos = [null, { x: -5, y: -2 }, { x: 0, y: -2 }, { x: 5, y: -2 }];

        // ── 노트 수집 ──
        const rawNotes = [];

        for (let ln = 1; ln <= 3; ln++) {
            // 일반 노트
            const normalLane = `normal_${ln}`;
            for (let m = 1; m <= nd.totalMeasures; m++) {
                const data = nd.lanes[normalLane][m];
                if (!data) continue;
                for (let s = 0; s < data.length; s++) {
                    if (data[s] === '1') {
                        const absSlot = nd.getAbsoluteSlotIndex(m, s);
                        rawNotes.push({ absSlot, time: getTime(absSlot), kind: 'normal', ln });
                    }
                }
            }

            // 롱 노트 — 연속된 '1' 구간을 하나의 노트로 묶기
            const longLane = `long_${ln}`;
            let inRun = false, runStart = 0;
            for (let m = 1; m <= nd.totalMeasures; m++) {
                const data = nd.lanes[longLane][m];
                for (let s = 0; s < spm; s++) {
                    const v = (data && s < data.length) ? data[s] : '0';
                    const absSlot = nd.getAbsoluteSlotIndex(m, s);
                    if (v === '1') {
                        if (!inRun) { inRun = true; runStart = absSlot; }
                    } else if (inRun) {
                        rawNotes.push({
                            absSlot: runStart, time: getTime(runStart),
                            endTime: getTime(absSlot), kind: 'long', ln,
                        });
                        inRun = false;
                    }
                }
            }
            if (inRun) {
                // 마지막 마디 끝까지 이어지는 롱 노트
                const endAbsSlot = nd.getAbsoluteSlotIndex(nd.totalMeasures, spm);
                rawNotes.push({
                    absSlot: runStart, time: getTime(runStart),
                    endTime: getTime(endAbsSlot), kind: 'long', ln,
                });
            }

            // 드래그 노트 ('1' = 중간, '2' = 끝 빨간 노트)
            const dragLane = `drag_${ln}`;
            for (let m = 1; m <= nd.totalMeasures; m++) {
                const data = nd.lanes[dragLane][m];
                if (!data) continue;
                for (let s = 0; s < data.length; s++) {
                    const v = data[s];
                    if (v === '1' || v === '2') {
                        const absSlot = nd.getAbsoluteSlotIndex(m, s);
                        rawNotes.push({
                            absSlot, time: getTime(absSlot),
                            kind: 'drag', ln, dragValue: v,
                        });
                    }
                }
            }
        }

        // 시간 → 절대 슬롯 순으로 정렬 후 ID 부여
        rawNotes.sort((a, b) => a.time - b.time || a.absSlot - b.absSlot);
        rawNotes.forEach((n, i) => { n.id = i + 1; });
        const noteById = new Map(rawNotes.map(n => [n.id, n]));

        // ── 드래그 nextId 체인 구성 (레인별, 시간 순서대로) ──
        const dragByLane = { 1: [], 2: [], 3: [] };
        for (const n of rawNotes) {
            if (n.kind === 'drag') dragByLane[n.ln].push(n);
        }
        for (let ln = 1; ln <= 3; ln++) {
            const chain = dragByLane[ln];
            for (let i = 0; i < chain.length; i++) {
                const n = chain[i];
                // '2'(빨간 끝 노트)는 항상 nextId: null
                n.nextId = (n.dragValue === '2')
                    ? null
                    : (i + 1 < chain.length ? chain[i + 1].id : null);
            }
        }

        // ── JSON notes 배열 구성 ──
        const notes = [];
        for (const n of rawNotes) {
            const pos = lanePos[n.ln];
            if (n.kind === 'normal') {
                notes.push({
                    id: n.id, type: 0, time: n.time,
                    position: { x: pos.x, y: pos.y },
                    duration: 0,
                    endPosition: { x: 0, y: 0 },
                });
            } else if (n.kind === 'long') {
                notes.push({
                    id: n.id, type: 1, time: n.time,
                    position: { x: pos.x, y: pos.y },
                    duration: n.endTime - n.time,
                    endPosition: { x: 0, y: 0 },
                });
            } else if (n.kind === 'drag') {
                const dragNote = {
                    id: n.id, type: 2, time: n.time,
                    position: { x: pos.x, y: pos.y },
                    duration: 0,
                    nextId: n.nextId,
                };
                // duration = 다음 드래그 노트까지의 시간 (끝 노트는 0)
                if (n.nextId != null) {
                    const nextN = noteById.get(n.nextId);
                    if (nextN) dragNote.duration = nextN.time - n.time;
                }
                notes.push(dragNote);
            }
        }

        // ── 곡 끝 마커 (type: -1) — 마지막 노트 이후 1마디 위치 ──
        if (notes.length > 0) {
            const songEnd = notes.reduce((max, n) => Math.max(max, n.time + (n.duration || 0)), 0);
            const secPerMeasure = 60 / nd.bpm * num;
            notes.push({
                id: notes.length + 1,
                type: -1,
                time: songEnd + secPerMeasure,
                position: { x: 0, y: 0 },
                duration: 0,
                endPosition: { x: 0, y: 0 },
            });
        }

        return JSON.stringify({ notes }, null, 4);
    }
}
