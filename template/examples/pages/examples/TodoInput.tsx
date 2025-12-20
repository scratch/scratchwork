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
    <div className="not-prose border border-gray-200 dark:border-gray-700 rounded-lg p-4 my-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Add a todo..."
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400"
        />
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors"
        >
          Add
        </button>
      </div>

      {todos.length > 0 && (
        <div className="mt-3">
          <ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
            {todos.map((todo) => (
              <li key={todo.id}>+ {todo.text}</li>
            ))}
          </ul>
          <button
            onClick={reset}
            className="mt-2 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
