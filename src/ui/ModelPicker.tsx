import { MODELS } from "../state/types";

interface Props {
  value: string;
  onChange: (model: string) => void;
}

export function ModelPicker({ value, onChange }: Props) {
  return (
    <select
      className="model-picker"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Model"
    >
      {MODELS.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}
