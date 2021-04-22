import joplin from 'api';

import {SettingItemType} from 'api/types';

const pluginName = 'io.github.wwoods.JoplinPluginReminder';

class RememberBlockMatch {
  constructor(public text: string, public start: number, public stop: number) {
  }
}
function* findRememberBlocks(body: string) {
  const regex = /(^|\n)(```remember( |\n|$).*?(^|\n)```)/gms;
  let m;
  while ((m = regex.exec(body)) !== null) {
    yield new RememberBlockMatch(m[2], m.index + 1, m.index + m[0].length);
  }
}

/** Looks like we'll need a CodeMirror plugin (https://github.com/CalebJohn/joplin-math-mode/blob/main/src/mathMode.ts)
 * as well as scanning note bodies for (newline + ```remember... newline ```).
 * */

joplin.plugins.register({
	onStart: async function() {
		console.info('joplin-plugin-remember plugin started!');

    let scanUnderway: boolean = false;
    const forceScan = async () => {
      while (scanUnderway) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      scanUnderway = true;
      try {
        await db.scan(true);
      }
      finally {
        scanUnderway = false;
      }
    };
    (window as any).rememberPluginForceScan = forceScan;
    console.info('window.rememberPluginForceScan() added!');

    await joplin.settings.registerSection(pluginName, {
      label: 'Remember',
      iconName: 'fas fa-heartbeat',
    });

    await joplin.settings.registerSetting('regenerate', {
        section: pluginName,
        public: true,
        type: SettingItemType.Bool,
        label: 'Regenerate for today (toggle to activate)',
        value: false,
    });

    joplin.settings.onChange(async (event: any) => {
      if (event.keys.indexOf('regenerate') === -1) return;
      await forceScan();
    });

    const db = new Db();
    await db.init();

    while (true) {
      if (!scanUnderway) {
        scanUnderway = true;
        try {
          await db.scan();
        }
        catch (e) {
          console.error(e);
        }
        finally {
          scanUnderway = false;
        }
      }

      // Only do so once per minute or so
      await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
    }
	},
});


class Db {
  static DB_NAME = 'Remember-DB';
  static DB_LOG_NAME = 'Log';
  static DB_REVIEW_NAME = 'Review';
  static SOURCE_URL_PREFIX = 'joplin-remember/';

  databaseFolder: null|string = null;
  logFolder: null|string = null;
  reviewFolder: null|string = null;

  get databaseFolderName() {
    return `${Db.DB_NAME}`;
  }

  get logFolderName() {
    return `${Db.DB_NAME}-${Db.DB_LOG_NAME}`;
  }

  get reviewFolderName() {
    return `${Db.DB_NAME}-${Db.DB_REVIEW_NAME}`;
  }

  /** Gets called both on startup AND if the metadata note isn't found.
   */
  async init() {
    // Find database folders
    this.databaseFolder = await this._ensureFolder(this.databaseFolderName, '');
    this.reviewFolder = await this._ensureFolder(this.reviewFolderName,
        this.databaseFolder);
    this.logFolder = await this._ensureFolder(this.logFolderName,
        this.databaseFolder);
  }


  async _ensureFolder(name: string, parent_id: string) {
    for await (const f of paginatedData(['folders'])) {
      if (f.parent_id !== parent_id) continue;
      if (f.title === name) {
        return f.id;
      }
    }

    console.log(`Could not find ${name}; creating`);
    const response = await joplin.data.post(['folders'], null, {
      title: name,
      parent_id: parent_id,
    });
    return response.id;
  }


  /** Scan the database for anything which was updated before today (that is,
   * yesterday). This is important because we assume the user may be editing
   * or re-editing anything from today.
   *
   * Arguments:
   *   force: true to re-process current day, regardless of other circumstances.
   * */
  async scan(force: boolean = false) {
    let metadata = await this.specificNote('metadata');
    if (metadata === null) {
      // If folders have been deleted, we must recreate them.
      await this.init();
      metadata = await joplin.data.post(['notes'], null, {
        title: 'Metadata',
        parent_id: this.databaseFolder,
        body: new PropertyGrid().toString(),
        source_url: this.specificNoteValue('metadata'),
      });
    }

    const pg = new PropertyGrid();
    pg.load(metadata.body);

    if (pg.properties.reviews_completed === undefined) pg.properties.reviews_completed = 0;

    const now = new Date();
    const nowyyyy = now.getFullYear();
    let nowmm: number|string = now.getMonth() + 1;
    if (nowmm < 10) nowmm = '0' + nowmm;
    let nowdd: number|string = now.getDate();
    if (nowdd < 10) nowdd = '0' + nowdd;
    let newLimit = `${nowyyyy}${nowmm}${nowdd}`;

    let lastUpdated = pg.properties.last_updated;
    console.log(`Considering update... ${newLimit} / ${lastUpdated}`);
    if (newLimit === lastUpdated && !force) {
      // Up to date, nothing to do.
      return;
    }

    let loader;
    const loaderFields = ['id', 'title', 'body', 'parent_id', 'updated_time'];
    if (lastUpdated === undefined) {
      loader = paginatedData(['notes'], {fields: loaderFields});
    }
    else {
      loader = paginatedData(['search'], {
        query: `updated:${lastUpdated}`,  // To not look at current docs:  -updated:${newLimit}`,
        fields: loaderFields,
      });
    }
    for await (const n of loader) {
      // This note was updated... process.
      if (n.parent_id === this.reviewFolder) {
        if (!force && n.updated_time > Date.now() - 3600 * 1000) {
          // Modified within last hour and not forced -- delay evaluating this
          // review. In fact, abort this whole process since we don't want to
          // trigger a new review while the user is actively working on an
          // existing review.
          console.log(`Aborting update due to ${n.id} / ${n.title} being modified `
              + `only ${(n.updated_time - Date.now()) / 60000} minutes ago.`);
          return;
        }
        const newlyCompleted = await this._scan_updateReview(n);
        if (newlyCompleted) pg.properties.reviews_completed++;
        continue;
      }

      // See if it has any `remember` blocks,
      // and update the meta-collection if it does/not.
      if (findRememberBlocks(n.body).next().done) continue;

      const noteName = this.logNoteName(n.id);
      const wasTracked = await this.specificNote(noteName);
      if (wasTracked) continue;

      const logPg = new PropertyGrid();
      await joplin.data.post(['notes'], null, {
        title: n.title,
        source_url: this.specificNoteValue(noteName),
        body: `[${n.title}](:/${n.id})\n${logPg.toString()}\n\n`,
        parent_id: this.logFolder,
      });
    }

    // Wait a second so that search is updated
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Now re-scan notes which have remember blocks attached, looking for
    // items to integrate into the reminder system. Then make new reminder note
    // for this day.
    console.log('re-scanning');
    const quizParts = [];
    for await (const note of paginatedData(['search'], {
        query: `notebook:${this.logFolderName}`,
        fields: ['id', 'title', 'body', 'parent_id']})) {
      quizParts.push(this._scan_getQuiz(note, newLimit,
            pg.properties.reviews_completed));
    }
    const quizParts2 = await Promise.all(quizParts);
    const quizFlat = [];
    for (const qp of quizParts2) {
      quizFlat.push.apply(quizFlat, qp);
    }
    arrayShuffle(quizFlat);

    // Build review note, post it
    const noteBody = []
    let qNumber = 1;
    for (const q of quizFlat) {
      noteBody.push(`# ${qNumber}\n\n${q}\n\n`);
      qNumber += 1;
    }
    const pgQuiz = new PropertyGrid();
    pgQuiz.properties.date = newLimit;
    pgQuiz.properties.reviewNumber = pg.properties.reviews_completed;
    noteBody.push(`# Data\n${pgQuiz.toString()}`);
    await joplin.data.post(['notes'], null, {
      title: `${newLimit} Review`,
      body: noteBody.join(''),
      parent_id: this.reviewFolder,
    });

    pg.properties.last_updated = newLimit;
    await joplin.data.put(['notes', metadata.id], null, {
      body: pg.toString(),
    });
  }


  /** Given a log note, return a list of quizzes to be immediately appended to
   * a quiz. May be empty list.
   * */
  async _scan_getQuiz(logNote: any, date: string, reviewsCompleted: number) {
    const logRecord = new LogRecord(logNote);
    const baseNote = await joplin.data.get(['notes', logRecord.note_id],
        {fields: ['id', 'title', 'body', 'parent_id']});
    await logRecord.loadBlocks(baseNote);
    await logRecord.write();

    const r = []
    for (const block of logRecord.blocksOfContent) {
      if (!block.needsQuiz(date, reviewsCompleted)) continue;
      // Note that this doesn't update the log record at all. That only happens
      // when a quiz is completed.
      r.push(block.makeQuiz());
    }

    return r;
  }


  /** Look at the given review note and append/update any information pertaining
   * to the questions contained within.
   *
   * Returns `true` if this is the first time the review was counted as
   * completed.
   * */
  async _scan_updateReview(reviewNote: any) {
    const reviewRecord = new ReviewRecord(reviewNote);
    reviewRecord.cleanupSections();

    if (reviewRecord.sections.length === 0) {
      // All questions were unanswered. Delete and move on.
      await joplin.data.delete(['notes', reviewNote.id]);
      return false;
    }

    for (const sec of reviewRecord.sections) {
      if (sec.score === undefined) continue;

      const logNote = await this.specificNote(this.logNoteName(sec.note_id));
      if (logNote === null) {
        console.error(`No log for ${sec.note_id}?`);
        continue;
      }

      const logRecord = new LogRecord(logNote);
      logRecord.updateScore(sec.block_id, reviewRecord.date,
          reviewRecord.reviewNumber, sec.score);
      await logRecord.write();
    }

    if (reviewRecord.properties.completed === undefined) {
      reviewRecord.properties.completed = true;
      await reviewRecord.update();
      return true;
    }

    return false;
  }


  /** Retrieves a note (with Joplin's internal ID) based on a deterministic ID.
   *
   * Returns `null` if it does not exist.
   *
   * This is achieved by hijacking the 'sourceurl' attribute of notes.
   * */
  async specificNote(id: string) {
    // NOTE -- as of 2021-04-19, deleting a notebook will keep deleted notes in
    // the search index! If we do not filter on both sourceurl and notebook, then
    // we cannot reset this plugin's data by simply deleting the notebook.
    const r = await joplin.data.get(['search'], {
      query: `sourceurl:${this.specificNoteValue(id)} notebook:${this.databaseFolderName}`,
      fields: ['id', 'body'],
    });
    if (r.items.length === 0) return null;
    if (r.items.length > 1) throw new Error(`Query 'sourceurl:${id}' had more than 1 result`);
    return r.items[0];
  }


  /** Computes the value field for a given specific note ID. */
  specificNoteValue(id: string) {
    return Db.SOURCE_URL_PREFIX + id;
  }


  /** Returns the ID for the specificNote corresponding to the given note.
   * */
  logNoteName(id: string) {
    return `note-${id}`;
  }
}


/** A class for dealing with log notes. */
class LogRecord {
  blocksOfContent: Array<RememberBlock> = [];
  blocksTracked: Array<LogBlockRecord> = [];
  logNote: any;
  note_id: string;
  note_title: string;
  pg: PropertyGrid;

  constructor(logNote) {
    let m;

    this.logNote = logNote;

    m = (/^\[(.*?)\]\(:\/([a-z0-9]+)\)/).exec(this.logNote.body);
    if (m === null) {
      throw new Error(`Could not find note_id from ${this.logNote.body}`);
    }
    this.note_title = m[1];
    this.note_id = m[2];

    m = (/^(\|(.|\n\|)*\|)\s*($|[^|])/gm).exec(this.logNote.body);
    if (m === null) {
      throw new Error(`Could not find log's property grid? ${this.logNote.body}`);
    }
    this.pg = new PropertyGrid();
    this.pg.load(m[1]);

    const r3 = /^# (\s+)(.*?)(?=$#)/gm;
    while ((m = r3.exec(this.logNote.body)) !== null) {
      const table = new NoteTable();
      table.load(m[2]);
      this.blocksTracked.push(new LogBlockRecord(m[1], table));
    }
  }


  /** Given a note (with title, body, source_url), load blocksOfContent into
   * this log document.
   *
   * If any remember block gets a new ID, the note is modified to reflect the
   * new ID. This is the only change which happens in a user's note.
   * */
  async loadBlocks(note: any) {
    console.log(`Finding content in ${note.id} / ${note.title}`);

    // Update title, if needed.
    this.note_title = note.title;

    const trackedBlocks = {};
    for (const b of this.blocksTracked) {
      trackedBlocks[b.blockId] = b;
    }

    let bodyChanged = false;
    let newBody = [];
    let lastMatchIndex = 0;

    this.blocksOfContent = [];
    for (const match of findRememberBlocks(note.body)) {
      const b = new RememberBlock(this, match);
      this.blocksOfContent.push(b);

      if (b.id === null) {
        bodyChanged = true;
        b.id = this.makeNewBlockId();
      }

      // Update body either way, in case another block changes
      if (lastMatchIndex !== match.start) {
        newBody.push(note.body.substring(lastMatchIndex, match.start));
      }
      newBody.push(b.toString());
      lastMatchIndex = match.stop;

      // Make a new log entry, if needed
      if (trackedBlocks[b.id] === undefined) {
        const table = new NoteTable();
        table.headers = ['date', 'reviewNum', 'userRating', 'efactor', 'daysToNext'];
        const tb = new LogBlockRecord(b.id, table);
        this.blocksTracked.push(tb);
        trackedBlocks[b.id] = tb;
      }
    }

    if (this.pg.properties.blockIdMax === undefined) {
      // This can happen when blocks are deleted or joplin-plugin-remember
      // gets re-initialized through the deletion of its notebook. In this case,
      // re-assign to highest known id.
      let idMax = 0;
      for (const b of this.blocksTracked) {
        idMax = Math.max(idMax, parseInt(b.blockId));
      }
      this.pg.properties.blockIdMax = idMax;
    }

    if (bodyChanged) {
      console.log(`Writing new block IDs for ${note.id} / ${note.title}`);
      if (lastMatchIndex !== note.body.length) {
        newBody.push(note.body.substring(lastMatchIndex));
      }
      await joplin.data.put(['notes', note.id], null, {
        body: newBody.join(''),
      });
    }
  }

  /** Allocate and remember a new block id. */
  makeNewBlockId() {
    if (this.pg.properties.blockIdMax === undefined) {
      this.pg.properties.blockIdMax = 0;
    }
    this.pg.properties.blockIdMax += 1;
    return this.pg.properties.blockIdMax.toString();
  }

  updateScore(blockId: string, date: string, reviewNum: number, score: number) {
  }

  async write() {
    const r = [];
    r.push(`[${this.note_title}](:/${this.note_id})\n`);
    r.push(this.pg.toString());
    r.push('\n');
    for (const block of this.blocksTracked) {
      r.push(block.toString());
    }
    await joplin.data.put(['notes', this.logNote.id], null, {
      body: r.join(''),
    });
  }
}


/** Within a LogRecord, this is the information for a single remember block. */
class LogBlockRecord {
  constructor(public blockId: string, public data: NoteTable) {
  }


  toString() {
    const r = [];
    r.push(`# ${this.blockId}\n`);
    r.push(this.data.toString());
    return r.join('');
  }
}


/** Content block within a note -- temporary class. */
class RememberBlock {
  id: string;

  constructor(public logRecord: LogRecord, public blockContent: RememberBlockMatch) {
    const name = /^```remember (\S+)/.exec(blockContent.text);
    if (name === null) {
      this.id = null;
    }
    else {
      this.id = name[1];
    }
  }


  needsQuiz(date: string, reviewNumber: number) {
    return true;
  }


  makeQuiz() {
    const r = [];
    r.push('Quizzy quiz time');

    r.push('\n\n');
    r.push('Level of recall:\n');
    for (let i = 5; i >= 0; --i) {
      r.push(`- [ ] ${i}\n`);
    }
    r.push(`\n\nID: ${this.logRecord.note_id}:${this.id}`);
    return r.join('');
  }


  toString() {
    const lines = this.blockContent.text.split('\n');
    if (!lines[0].startsWith('```remember')) throw new Error(`Bad first line? ${lines[0]}`);
    lines[0] = '```remember ' + this.id;
    return lines.join('\n');
  }
}


/** A class for dealing with review notes. */
class ReviewRecord {
  data;
  date: string;
  reviewNote: any;
  reviewNumber: number;

  constructor(reviewNote) {
    this.reviewNote = reviewNote;
    this.data = new PropertyGrid();
  }

  get sections() {
    return [];
  }

  get properties() {
    return this.data.properties;
  }

  /** Delete notes without responses */
  cleanupSections() {
  }

  async update() {
  }
}


/** A class which has one or more columns and renders its data as a markdown
 * table. */
class NoteTable {
  headers: Array<string> = [];
  rowData: Array<Array<any>> = [];

  load(body: string) {
    this.headers = [];
    this.rowData = [];

    let seen = 0;
    for (const line of body.split('\n')) {
      if (line.trim().length === 0) continue;
      seen += 1;

      if (seen === 1) {
        if (line[0] !== '|' || line[line.length - 1] !== '|') {
          throw new Error(`Unexpected line: ${line}`);
        }

        this.headers = line.substring(2, line.length - 2).split(' | ');
      }
      else if (seen === 2) {
        if (!line.startsWith('| :----: |')) {
          throw new Error(`Unexpected line: ${line}`);
        }
      }
      else {
        const matchStr = '^\\| ' + this.headers.map(x => '(.*)').join(' \\| ') + ' \\|$';
        const match = new RegExp(matchStr).exec(line);
        if (match === null) {
          throw new Error(`Bad line for ${this.headers.join(', ')}, regex '${matchStr}'? ${line}`);
        }

        const arr = [];
        for (let i = 1, m = match.length; i < m; i++) {
          arr.push(JSON.parse(this._escapeUndo(match[i])));
        }
        this.rowData.push(arr);
      }
    }
  }


  *rows() {
    const h = this.headers;
    for (const row of this.rowData) {
      const rowobj = {} as any;
      for (let i = 0, m = h.length; i < m; i++) {
        rowobj[h[i]] = row[i];
      }
      yield rowobj;
    }
  }


  toString() {
    const r = [];
    r.push('| ' + this.headers.join(' | ') + ' |');
    r.push('| ' + this.headers.map(x => ':----:').join(' | ') + ' |');
    for (const vals of this.rowData) {
      const rowVals = vals.map(x => this._escape(JSON.stringify(x)));
      r.push('| ' + rowVals.join(' | ') + ' |');
    }
    r.push('');  // Always end in empty newline
    return r.join('\n');
  }

  _escape(v: string) {
    return v.replace('\\', '\\\\').replace('|', '\\|');
  }

  _escapeUndo(v: string) {
    return v.replace('\\|', '|').replace('\\\\', '\\');
  }
}


/** A class which tracks properties (key/value) and can store them in Markdown.
 * */
class PropertyGrid {
  properties: {[key: string]: any} = {};

  load(body: string) {
    this.properties = {};

    const nt = new NoteTable();
    nt.load(body);
    if (nt.headers.length !== 2 || nt.headers[0] !== 'Key' || nt.headers[1] !== 'Value') {
      throw new Error(`Unrecognized PropertyGrid: ${body}`);
    }
    for (const row of nt.rows()) {
      this.properties[row.Key] = row.Value;
    }
  }


  toString() {
    const under = new NoteTable();
    under.headers = ['Key', 'Value'];
    under.rowData = Object.entries(this.properties);
    return under.toString();
  }
}

/** In-place shuffle of array, via Fisher-Yates. */
function arrayShuffle(arr: Array<any>) {
  let idx = arr.length, randidx = 0;
  let tmp: any;

  while (idx !== 0) {
    randidx = Math.floor(Math.random() * idx);
    idx--;

    tmp = arr[idx];
    arr[idx] = arr[randidx];
    arr[randidx] = tmp;
  }
}

async function* paginatedData(path, query=undefined) {
  if (query === undefined) query = {};
  query = Object.assign({}, query);

  let page: number = 1;
  while (true) {
    const r = await joplin.data.get(path, query);
    for (const i of r.items) {
      yield i;
    }
    if (!r.has_more) break;

    page += 1;
    query.page = page;
  }
}

