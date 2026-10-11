import { describe, expect, it } from 'vitest';
import { parseStoresCsv } from '../../src/services/csvService.js';

const H = 'store_id,store_name,address,city,state,country';
const run = (text) => {
  try {
    return { stores: parseStoresCsv(Buffer.from(text)) };
  } catch (e) {
    return { err: e };
  }
};

describe('csvService', () => {
  it('parses a valid file in any column order', () => {
    const { stores } = run('store_name,store_id,address,city,state,country\nAcme,S1,1 Main,Austin,TX,US\n');
    expect(stores).toEqual([
      { store_id: 'S1', store_name: 'Acme', address: '1 Main', city: 'Austin', state: 'TX', country: 'US' },
    ]);
  });

  it('strips a BOM and trims values', () => {
    const { stores } = run(`﻿${H}\n S1 , Acme ,a,c,s,US\n`);
    expect(stores[0]).toMatchObject({ store_id: 'S1', store_name: 'Acme' });
  });

  it('names missing and extra headers', () => {
    const { err } = run('store_id,store_name,address,city,state,zip\nS1,A,a,c,s,1\n');
    expect(err.code).toBe('INVALID_HEADERS');
    expect(err.message).toMatch(/missing: country/);
    expect(err.message).toMatch(/unexpected: zip/);
  });

  it('reports blank store_id / store_name with row numbers', () => {
    const { err } = run(`${H}\n,A,a,c,s,US\nS2,,a,c,s,US\n`);
    expect(err.code).toBe('INVALID_ROWS');
    expect(err.details).toEqual([
      { row: 2, message: 'store_id is required' },
      { row: 3, message: 'store_name is required' },
    ]);
  });

  it('rejects duplicate store_id with row numbers', () => {
    const { err } = run(`${H}\nS1,A,a,c,s,US\nS2,B,a,c,s,US\nS1,C,a,c,s,US\n`);
    expect(err.details).toHaveLength(1);
    expect(err.details[0].row).toBe(4);
    expect(err.details[0].message).toMatch(/first seen on row 2/);
  });

  it('caps reported problems at 10', () => {
    const rows = Array.from({ length: 25 }, () => ',A,a,c,s,US').join('\n');
    expect(run(`${H}\n${rows}\n`).err.details).toHaveLength(10);
  });

  it('rejects empty and header-only files', () => {
    expect(run('').err.code).toBe('EMPTY_FILE');
    expect(run('   \n').err.code).toBe('EMPTY_FILE');
    expect(run(`${H}\n`).err.code).toBe('NO_ROWS');
  });

  it('allows empty address/city/state', () => {
    const { stores } = run(`${H}\nS1,A,,,,\n`);
    expect(stores[0]).toMatchObject({ address: '', city: '', state: '', country: '' });
  });
});
