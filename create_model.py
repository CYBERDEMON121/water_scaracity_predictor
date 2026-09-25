# create_model.py
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
import pickle

# Dummy data
data = {
    'rainfall': [200, 100, 50, 300, 20, 400],
    'population': [1000, 5000, 2000, 800, 10000, 1500],
    'temperature': [25, 35, 30, 20, 40, 22],
    'water_usage': [100, 200, 150, 80, 250, 90],
    'scarcity': ['Low', 'High', 'Moderate', 'Low', 'High', 'Low']
}

df = pd.DataFrame(data)

# Features and target
X = df[['rainfall', 'population', 'temperature', 'water_usage']]
y = df['scarcity']

# Train model
model = RandomForestClassifier()
model.fit(X, y)

# Save model
pickle.dump(model, open('model/water_model.pkl', 'wb'))

print("Model created and saved!")
