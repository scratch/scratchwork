import React, { useState } from "react";
import { useTodos } from "./useTodos";

export default function TodoInput() {
  const { todos, addTodo, reset } = useTodos();
  const [input, setInput] = useState("");

  const handleAdd = () => {
    addTodo(input);
    setInput("");
  };

  return (
    <div className="not-prose border border-gray-200 rounded-lg p-4 my-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Add a todo..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md bg-white text-gray-900 placeholder-gray-400"
        />
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-700 transition-colors"
        >
          Add
        </button>
      </div>

      {todos.length > 0 && (
        <div className="mt-3">
          <ul className="text-sm text-gray-600 space-y-1">
            {todos.map((todo) => (
              <li key={todo.id}>+ {todo.text}</li>
            ))}
          </ul>
          <button
            onClick={reset}
            className="mt-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
