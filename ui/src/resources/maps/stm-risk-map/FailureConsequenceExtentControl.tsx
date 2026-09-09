import {
  FAILURE_CONSEQUENCE_EXTENT_OPTIONS,
} from "./failureConsequence";

type Props = {
  disabled?: boolean;
  value: number;
  onChange: (value: number) => void;
};

export default function FailureConsequenceExtentControl({ disabled = false, value, onChange }: Props) {
  return (
    <label className="failure-consequence-extent-control">
      <span>Map extent</span>
      <select
        aria-label="Consequence map extent"
        disabled={disabled}
        value={value.toFixed(1)}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {FAILURE_CONSEQUENCE_EXTENT_OPTIONS.map((miles) => (
          <option key={miles} value={miles.toFixed(1)}>
            {miles.toFixed(1)} × {miles.toFixed(1)} mi
          </option>
        ))}
      </select>
    </label>
  );
}
