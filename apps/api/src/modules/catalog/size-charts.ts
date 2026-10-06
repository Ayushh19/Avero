import type { DbOrTx } from '../../db/client';
import { sizeCharts } from '../../db/schema';

/** Reference size charts (UK/IND primary). Imported products are linked to these by gender. */
export const SIZE_CHARTS = [
  {
    name: 'Men footwear',
    guidance:
      'Stand on a sheet of paper, mark your heel and longest toe, and measure the distance in cm. Between sizes? Size up.',
    rows: [
      { ukInd: '6', us: '7', eu: '40', cm: 24.6 },
      { ukInd: '7', us: '8', eu: '41', cm: 25.4 },
      { ukInd: '8', us: '9', eu: '42', cm: 26.2 },
      { ukInd: '9', us: '10', eu: '43', cm: 27.1 },
      { ukInd: '10', us: '11', eu: '44.5', cm: 27.9 },
      { ukInd: '11', us: '12', eu: '45.5', cm: 28.8 },
      { ukInd: '12', us: '13', eu: '47', cm: 29.6 },
    ],
  },
  {
    name: 'Women footwear',
    guidance:
      'Stand on a sheet of paper, mark your heel and longest toe, and measure the distance in cm. Between sizes? Size up.',
    rows: [
      { ukInd: '3', us: '5', eu: '36', cm: 22.4 },
      { ukInd: '4', us: '6', eu: '37', cm: 23.2 },
      { ukInd: '5', us: '7', eu: '38', cm: 24.1 },
      { ukInd: '6', us: '8', eu: '39', cm: 24.9 },
      { ukInd: '7', us: '9', eu: '40.5', cm: 25.7 },
      { ukInd: '8', us: '10', eu: '42', cm: 26.6 },
    ],
  },
];

export async function ensureSizeCharts(db: DbOrTx): Promise<void> {
  await db.insert(sizeCharts).values(SIZE_CHARTS).onConflictDoNothing();
}
