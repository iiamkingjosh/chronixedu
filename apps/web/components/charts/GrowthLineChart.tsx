'use client';

import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, Legend } from 'recharts';

interface Props {
  data: Array<{ month: string; schools: number; students: number }>;
}

export default function GrowthLineChart({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip />
        <Legend verticalAlign="top" height={36} />
        <Line type="monotone" dataKey="schools" name="Schools" stroke="#003366" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="students" name="Students" stroke="#FF761B" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
