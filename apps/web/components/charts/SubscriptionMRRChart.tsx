'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface Props {
  data: Array<{ plan: string; mrr: number }>;
}

function formatNaira(value: number) {
  return `₦${Math.round(value).toLocaleString('en-NG')}`;
}

export default function SubscriptionMRRChart({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="plan" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} tickFormatter={(value: number) => `₦${value.toLocaleString('en-NG')}`} />
        <Tooltip formatter={(value) => formatNaira(Number(value))} />
        <Bar dataKey="mrr" fill="#003366" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
