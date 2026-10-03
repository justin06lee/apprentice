/**
 * apprentice's one database. Opened by the main process for everything and
 * by the import worker for the single transaction that saves a book, which
 * is why it runs in WAL mode: the reader keeps reading while a book lands.
 *
 * Migrations are append-only. `user_version` counts how many have run.
 */
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  create table books (
    id text primary key,
    title text not null,
    author text,
    file_name text not null,
    file_hash text not null,
    page_count integer not null default 0,
    status text not null default 'importing',
    import_progress real not null default 0,
    import_stage text,
    error text,
    added_at integer not null,
    opened_at integer,
    has_cover integer not null default 0,
    body_size real not null default 10,
    weight integer not null default 0,
    position text,
    warnings text
  );
  create unique index books_hash on books(file_hash);

  create table sections (
    id integer primary key,
    book_id text not null references books(id) on delete cascade,
    parent_id integer,
    ord integer not null,
    level integer not null,
    title text not null,
    page integer not null,
    block_id integer,
    kind text not null,
    is_unit integer not null,
    unit_id integer not null,
    weight integer not null default 0
  );
  create index sections_book on sections(book_id, ord);

  create table blocks (
    id integer primary key,
    book_id text not null references books(id) on delete cascade,
    unit_id integer not null,
    section_id integer not null,
    ord integer not null,
    type text not null,
    level integer not null default 0,
    text text not null,
    marks text,
    page integer not null,
    bbox text,
    asset text,
    width real not null default 0,
    height real not null default 0,
    boxed integer not null default 0,
    label text,
    refs text,
    weight integer not null default 0,
    custom_text text,
    custom_source text,
    custom_at integer
  );
  create index blocks_unit on blocks(unit_id, ord);
  create index blocks_book on blocks(book_id, ord);

  -- Its own copy of each block's current text (the reader's version when
  -- there is one), so snippets always match what is on screen.
  create virtual table blocks_fts using fts5(text, tokenize = 'unicode61 remove_diacritics 2');
  create trigger blocks_ai after insert on blocks begin
    insert into blocks_fts(rowid, text) values (new.id, coalesce(new.custom_text, new.text));
  end;
  create trigger blocks_ad after delete on blocks begin
    delete from blocks_fts where rowid = old.id;
  end;
  create trigger blocks_au after update of text, custom_text on blocks begin
    update blocks_fts set text = coalesce(new.custom_text, new.text) where rowid = new.id;
  end;

  create table reads (
    block_id integer primary key,
    book_id text not null references books(id) on delete cascade,
    unit_id integer not null,
    at integer not null,
    dwell_ms integer not null default 0
  );
  create index reads_unit on reads(unit_id);
  create index reads_book on reads(book_id);

  create table reading_time (
    book_id text not null references books(id) on delete cascade,
    day text not null,
    ms integer not null default 0,
    primary key (book_id, day)
  );

  create table highlights (
    id integer primary key,
    book_id text not null references books(id) on delete cascade,
    block_id integer not null,
    unit_id integer not null,
    start integer not null,
    end integer not null,
    quote text not null,
    on_custom integer not null default 0,
    color text not null,
    note text not null default '',
    created_at integer not null,
    updated_at integer not null
  );
  create index highlights_unit on highlights(unit_id);
  create index highlights_book on highlights(book_id, updated_at);

  create table sketches (
    id integer primary key,
    book_id text not null references books(id) on delete cascade,
    block_id integer,
    unit_id integer,
    title text not null default '',
    data text not null,
    svg text not null default '',
    created_at integer not null,
    updated_at integer not null
  );
  create index sketches_book on sketches(book_id, updated_at);

  create table cards (
    id integer primary key,
    book_id text not null references books(id) on delete cascade,
    block_id integer,
    unit_id integer,
    kind text not null,
    front text not null,
    back text not null default '',
    source text not null,
    status text not null,
    due integer not null,
    stability real not null default 0,
    difficulty real not null default 0,
    elapsed_days real not null default 0,
    scheduled_days real not null default 0,
    learning_steps integer not null default 0,
    reps integer not null default 0,
    lapses integer not null default 0,
    state integer not null default 0,
    last_review integer,
    created_at integer not null
  );
  create index cards_due on cards(status, due);
  create index cards_unit on cards(book_id, unit_id);

  create table review_log (
    id integer primary key,
    card_id integer not null references cards(id) on delete cascade,
    book_id text not null,
    rating integer not null,
    state integer not null,
    due integer not null,
    stability real,
    difficulty real,
    elapsed_days real,
    last_elapsed_days real,
    scheduled_days real,
    learning_steps integer,
    review integer not null,
    duration_ms integer
  );
  create index review_log_time on review_log(review);

  create table concepts (
    id integer primary key,
    key text not null unique,
    name text not null,
    created_at integer not null
  );

  create table concept_books (
    concept_id integer not null references concepts(id) on delete cascade,
    book_id text not null references books(id) on delete cascade,
    importance real not null default 0,
    def_block_id integer,
    definition text,
    source text not null default 'auto',
    primary key (concept_id, book_id)
  );
  create index concept_books_book on concept_books(book_id);

  create table mentions (
    concept_id integer not null references concepts(id) on delete cascade,
    block_id integer not null,
    book_id text not null references books(id) on delete cascade,
    unit_id integer not null,
    count integer not null default 1,
    is_def integer not null default 0,
    primary key (concept_id, block_id)
  );
  create index mentions_block on mentions(block_id);
  create index mentions_unit on mentions(unit_id);

  create table edges (
    a integer not null references concepts(id) on delete cascade,
    b integer not null references concepts(id) on delete cascade,
    book_id text not null references books(id) on delete cascade,
    weight real not null,
    kind text not null,
    label text,
    primary key (a, b, book_id, kind)
  );
  create index edges_book on edges(book_id);

  create table card_concepts (
    card_id integer not null references cards(id) on delete cascade,
    concept_id integer not null references concepts(id) on delete cascade,
    primary key (card_id, concept_id)
  );
  create index card_concepts_concept on card_concepts(concept_id);

  create table chats (
    id integer primary key,
    book_id text not null references books(id) on delete cascade,
    block_id integer,
    title text not null,
    created_at integer not null,
    updated_at integer not null
  );
  create index chats_book on chats(book_id, updated_at);

  create table chat_messages (
    id integer primary key,
    chat_id integer not null references chats(id) on delete cascade,
    role text not null,
    content text not null,
    quote text,
    block_id integer,
    created_at integer not null
  );
  create index chat_messages_chat on chat_messages(chat_id, id);

  -- Which of a unit's once-per-chapter AI jobs have run.
  create table unit_jobs (
    unit_id integer not null,
    job text not null,
    at integer not null,
    primary key (unit_id, job)
  );

  create table settings (
    key text primary key,
    value text not null
  );
  `,
  // 2 — the book is read on its own pages. Everything the reader leaves
  // behind is anchored to a page and a range of that page's text layer
  // (shared/pages.ts); block ids stay where they are useful, for the
  // chapter a thing belongs to. Highlights and rewrites made on the old
  // reflowed text keep their words and are placed on their page the first
  // time the book is opened (start = -1 until then).
  `
  alter table highlights add column page integer;
  update highlights set page = (select b.page from blocks b where b.id = highlights.block_id), start = -1, end = -1;
  create index highlights_page on highlights(book_id, page);

  create table versions (
    id integer primary key,
    book_id text not null references books(id) on delete cascade,
    page integer not null,
    start integer not null,
    end integer not null,
    -- The book's words the version stands in for.
    quote text not null,
    text text not null,
    source text not null,
    created_at integer not null,
    updated_at integer not null
  );
  create index versions_page on versions(book_id, page);
  insert into versions (book_id, page, start, end, quote, text, source, created_at, updated_at)
    select book_id, page, -1, -1, text, custom_text, coalesce(custom_source, 'user'), coalesce(custom_at, 0), coalesce(custom_at, 0)
    from blocks where custom_text is not null;

  alter table sketches add column page integer;
  -- Where on the page the sketch is pinned, in points from the top.
  alter table sketches add column y real;
  update sketches set page = (select b.page from blocks b where b.id = sketches.block_id);

  alter table cards add column page integer;
  update cards set page = (select b.page from blocks b where b.id = cards.block_id);

  alter table chats add column page integer;
  update chats set page = (select b.page from blocks b where b.id = chats.block_id);
  alter table chat_messages add column page integer;
  alter table chat_messages add column start integer;
  alter table chat_messages add column end integer;
  update chat_messages set page = (select b.page from blocks b where b.id = chat_messages.block_id);

  create table page_reads (
    book_id text not null references books(id) on delete cascade,
    page integer not null,
    at integer not null,
    dwell_ms integer not null default 0,
    primary key (book_id, page)
  );
  `,
];

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = wal;
    pragma synchronous = normal;
    pragma foreign_keys = on;
    pragma busy_timeout = 8000;
    pragma temp_store = memory;
    pragma cache_size = -32000;
  `);
  const version = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("begin");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
  return db;
}

/** Run `fn` in a transaction, rolling back if it throws. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
